#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  CHAT_SUMMARY_FIXTURE_REPLY,
  isChatSummaryThreadStartParams,
  isChatSummaryTurnInput,
} from './codex-chat-summary-traffic.mjs';

const logPath = process.env.CANOPY_E2E_CODEX_LOG_PATH;
const statePath = process.env.CANOPY_E2E_CODEX_STATE_PATH;
const codexHome = process.env.CANOPY_E2E_CODEX_CANONICAL_HOME ?? process.cwd();
// Writing `auth.json` needs an EXPLICITLY configured canonical home. `codexHome`
// falls back to `process.cwd()`, which for a locally launched Electron run is the
// repository root — that is exactly how a stray `auth.json` once reached a
// commit. Specs that assert auth state set the variable; the rest must not get a
// credentials-shaped file written into whatever directory they started in.
const authJsonPath =
  process.env.CANOPY_E2E_CODEX_CANONICAL_HOME === undefined
    ? null
    : path.join(process.env.CANOPY_E2E_CODEX_CANONICAL_HOME, 'auth.json');
const accountPath = process.env.CANOPY_E2E_CODEX_ACCOUNT_PATH;
const loginAccount = process.env.CANOPY_E2E_CODEX_LOGIN_ACCOUNT;
const loginResultPath = process.env.CANOPY_E2E_CODEX_LOGIN_RESULT_PATH;
const accountReadFailurePath =
  process.env.CANOPY_E2E_CODEX_ACCOUNT_READ_FAILURE_PATH;
let loginWatcher;
let pendingLoginId;
const watcherStartTurnIds = new Map();
const lateSteerConversationTurnCounts = new Map();
const scheduledTurnCompletions = new Set();
const completedTurns = new Set();

if (process.argv[2] === 'login' && accountPath && loginAccount) {
  writeFileSync(accountPath, `${loginAccount}\n`, 'utf8');
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ timestamp: Date.now(), kind: 'login', account: loginAccount })}\n`,
      'utf8',
    );
  }
  process.stdout.write(`Signed in as ${loginAccount}\n`);
  process.exit(0);
}

const accountAtStartup =
  accountPath && existsSync(accountPath)
    ? readFileSync(accountPath, 'utf8').trim()
    : null;
if (authJsonPath) {
  writeFileSync(
    authJsonPath,
    `${JSON.stringify(
      accountAtStartup
        ? { account: accountAtStartup }
        : { apiKey: 'synthetic-e2e-key' },
    )}\n`,
    'utf8',
  );
}
const reply =
  process.env.CANOPY_E2E_CODEX_REPLY ??
  (accountAtStartup
    ? `Reply from Codex account ${accountAtStartup}`
    : 'Reply from the deterministic Codex app-server fixture');
const mode = process.env.CANOPY_E2E_CODEX_MODE ?? 'normal';
// The replay adapter imports the turn-state harness contract under scripts/,
// which the public desktop export omits, so load it only for replay scenarios.
// Keep this check in step with readCodexReplayScenarioOptions, which returns
// {} when the variable is undefined.
const codexScenarioOptions =
  process.env.CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS === undefined
    ? {}
    : (
        await import('./lifecycle-replay-codex.mjs')
      ).readCodexReplayScenarioOptions(process.env);
const liveBackgroundTerminalsByThread = new Map();
const liveThreadStatusesById = new Map();
let conversationThreadId;
let closingResumeCount = 0;
// `watcher-start-held` withholds the conversation's turn/start response and
// turn/started notification until this separate release file exists. It does
// not use CANOPY_E2E_CODEX_RELEASE_PATH, which gates existing fixture modes.
// Summary helpers bypass this gate; the released turn completes on a steer.
// `watcher-steer-late-refusal` keeps the root turn active long enough to test a
// turn/steer refusal that arrives after the Codex client's request deadline.
// Process-local loaded state, including after unsubscribe. A fresh process
// may apply resume configuration; an already loaded thread keeps its provider.
const loadedThreadIds = new Set();
const crashPath = process.env.CANOPY_E2E_CODEX_CRASH_PATH;
const failInject = process.env.CANOPY_E2E_CODEX_FAIL_INJECT === 'true';
// Mimics the OpenAI Responses API rejecting provider-private reasoning
// payloads that were produced by a different upstream provider. Enabled only
// by specs that assert Codex history is sanitized across a route change.
const strictReasoning =
  process.env.CANOPY_E2E_CODEX_STRICT_REASONING === 'true';
const pluginFixturePath =
  process.env.CANOPY_E2E_CODEX_PLUGIN_FIXTURE_PATH?.trim();
// `perf-script` mode (desktop performance harness): a turn whose input
// carries a `[Canopy-C…]` marker replays `<dir>/<marker>.json`.
const perfScriptDir = process.env.CANOPY_E2E_CODEX_PERF_SCRIPT_DIR?.trim();

if (!statePath) {
  process.stderr.write('CANOPY_E2E_CODEX_STATE_PATH is required\n');
  process.exit(64);
}

const pluginFixture = pluginFixturePath
  ? JSON.parse(readFileSync(pluginFixturePath, 'utf8'))
  : null;

function emptyPluginList() {
  return {
    marketplaces: [],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function emptyInstalledPlugins() {
  return { marketplaces: [], marketplaceLoadErrors: [] };
}

if (mode === 'account-cutover' && crashPath) {
  const crashWatcher = setInterval(() => {
    if (!existsSync(crashPath)) return;
    clearInterval(crashWatcher);
    rmSync(crashPath, { force: true });
    process.exit(17);
  }, 25);
}

// Real Codex keeps a thread's writer in the process that loaded it until that
// process unloads the thread or exits; `thread/unsubscribe` does not release it.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadState() {
  if (!existsSync(statePath)) {
    return { nextThread: 1, nextTurn: 1, threads: {} };
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function saveState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function log(entry) {
  if (logPath) {
    appendFileSync(
      logPath,
      // `pid` lets specs prove which pooled app-server served a request.
      `${JSON.stringify({ timestamp: Date.now(), pid: process.pid, ...entry })}\n`,
      'utf8',
    );
  }
}

function send(message) {
  updateLiveCodexListState(message);
  process.stdout.write(`${JSON.stringify(message)}\n`);
  log({ direction: 'server', message });
}

function updateLiveCodexListState(message) {
  if (
    !message ||
    ![
      'thread/started',
      'thread/status/changed',
      'item/started',
      'item/completed',
    ].includes(message.method)
  ) {
    return;
  }
  const params = message.params ?? {};
  if (message.method === 'thread/started' && params.thread?.id) {
    liveThreadStatusesById.set(
      params.thread.id,
      params.thread.status ?? { type: 'idle' },
    );
    return;
  }
  if (message.method === 'thread/status/changed' && params.threadId) {
    liveThreadStatusesById.set(
      params.threadId,
      params.status ?? { type: 'idle' },
    );
    return;
  }
  const item = params.item;
  if (item?.type !== 'commandExecution' || !params.threadId) return;
  const threadId = params.threadId;
  const itemId = String(item.id ?? '');
  const commands = liveBackgroundTerminalsByThread.get(threadId) ?? new Map();
  if (
    message.method === 'item/started' &&
    item.status === 'inProgress' &&
    item.processId == null &&
    codexScenarioOptions.syntheticProcessId &&
    (codexScenarioOptions.threadId === undefined ||
      codexScenarioOptions.threadId === threadId)
  ) {
    // Keep replay skeleton processIds null by default. Only opt-in scenarios
    // replace the synthetic in-progress process id.
    item.processId = codexScenarioOptions.syntheticProcessId;
  }
  if (
    message.method === 'item/started' &&
    item.status === 'inProgress' &&
    typeof item.processId === 'string'
  ) {
    commands.set(itemId, {
      itemId,
      processId: item.processId,
      command: item.command,
      cwd: item.cwd,
      osPid: null,
      cpuPercent: null,
      rssKb: null,
    });
    liveBackgroundTerminalsByThread.set(threadId, commands);
    return;
  }
  if (message.method === 'item/completed' || item.status !== 'inProgress') {
    commands.delete(itemId);
    if (commands.size === 0) liveBackgroundTerminalsByThread.delete(threadId);
    else liveBackgroundTerminalsByThread.set(threadId, commands);
  }
}

function listThreadScope(method, params) {
  if (method === 'thread/backgroundTerminals/list') return params.threadId;
  return (
    params.parentThreadId ?? params.ancestorThreadId ?? conversationThreadId
  );
}

function codexListOverride(method, params) {
  const threadId = listThreadScope(method, params);
  if (
    codexScenarioOptions.threadId !== undefined &&
    threadId !== codexScenarioOptions.threadId
  ) {
    const result = { data: [], nextCursor: null };
    return {
      result:
        method === 'thread/list'
          ? { ...result, backwardsCursor: null }
          : result,
    };
  }
  if (codexScenarioOptions.listFailure) {
    return { error: { ...codexScenarioOptions.listFailure } };
  }
  if (codexScenarioOptions.listPages) {
    const page = codexScenarioOptions.listPages.find(
      (candidate) => candidate.cursor === (params.cursor ?? null),
    );
    const result = page
      ? {
          data: structuredClone(page.data),
          nextCursor: page.nextCursor,
        }
      : { data: [], nextCursor: null };
    return {
      result:
        method === 'thread/list'
          ? { ...result, backwardsCursor: null }
          : result,
    };
  }
  return undefined;
}

function paginateCodexList(data, params) {
  const cursor = params.cursor ?? null;
  const match =
    typeof cursor === 'string' ? /^offset:(\d+)$/.exec(cursor) : null;
  const offset = match ? Number(match[1]) : 0;
  const limit =
    Number.isSafeInteger(params.limit) && params.limit > 0
      ? params.limit
      : Math.max(1, data.length);
  const page = data.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    data: page,
    nextCursor: nextOffset < data.length ? `offset:${nextOffset}` : null,
  };
}

function listCodexThreads(state, params) {
  const threads = Object.values(state.threads)
    .filter((thread) => thread.purpose !== 'chat-summary')
    .map((thread) => {
      const row = threadPayload(thread).thread;
      const status = liveThreadStatusesById.get(thread.id);
      if (status) row.status = structuredClone(status);
      if (thread.parentThreadId) row.parentThreadId = thread.parentThreadId;
      return row;
    });
  let filtered = threads;
  if (params.parentThreadId) {
    filtered = filtered.filter(
      (thread) => thread.parentThreadId === params.parentThreadId,
    );
  }
  if (params.ancestorThreadId) {
    const ancestor = params.ancestorThreadId;
    const rowsById = new Map(threads.map((thread) => [thread.id, thread]));
    filtered = filtered.filter((thread) => {
      let parentId = thread.parentThreadId;
      const visited = new Set();
      while (parentId && !visited.has(parentId)) {
        if (parentId === ancestor) return true;
        visited.add(parentId);
        parentId = rowsById.get(parentId)?.parentThreadId;
      }
      return false;
    });
  }
  if (params.cwd !== undefined) {
    const cwdValues = Array.isArray(params.cwd) ? params.cwd : [params.cwd];
    filtered = filtered.filter((thread) => cwdValues.includes(thread.cwd));
  }
  return filtered;
}

function respondToCodexListRequest(message, state) {
  const override = codexListOverride(message.method, message.params ?? {});
  if (override) {
    send({ id: message.id, ...override });
    return;
  }
  const params = message.params ?? {};
  const data =
    message.method === 'thread/list'
      ? listCodexThreads(state, params)
      : Array.from(
          liveBackgroundTerminalsByThread.get(params.threadId)?.values() ?? [],
          (terminal) => structuredClone(terminal),
        );
  const page = paginateCodexList(data, params);
  send({
    id: message.id,
    result:
      message.method === 'thread/list'
        ? { ...page, backwardsCursor: null }
        : page,
  });
}

let codexReplay;
let pendingConversationInitialize;
if (mode === 'replay' && process.env.CANOPY_LIFECYCLE_REPLAY_FIXTURE?.trim()) {
  const replayModulePath = process.env.CANOPY_LIFECYCLE_REPLAY_MODULE?.trim();
  if (!replayModulePath || !path.isAbsolute(replayModulePath)) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_MODULE must be an absolute path in replay mode',
    );
  }
  const replayAdapterPath = path.join(
    path.dirname(replayModulePath),
    'lifecycle-replay-codex.mjs',
  );
  const replayAdapter = await import(pathToFileURL(replayAdapterPath).href);
  if (typeof replayAdapter.createCodexReplay !== 'function') {
    throw new TypeError(
      'lifecycle-replay-codex.mjs must export createCodexReplay',
    );
  }
  codexReplay = replayAdapter.createCodexReplay({
    env: process.env,
    send,
    onError(error) {
      log({
        direction: 'lifecycle-replay-error',
        error: error?.stack ?? String(error),
      });
    },
  });
}

function reportCodexReplayError(error) {
  log({
    direction: 'lifecycle-replay-error',
    error: error?.stack ?? String(error),
  });
}

function dispatchCodexReplayRequest(message, context) {
  if (!codexReplay) return false;
  try {
    const result = codexReplay.handleRequest(message, context);
    if (result && typeof result.then === 'function') {
      void result.then((handled) => {
        if (handled !== true) {
          reportCodexReplayError(
            new Error(`Codex replay did not handle ${message.method}`),
          );
        }
      }, reportCodexReplayError);
      return true;
    }
    return result === true;
  } catch (error) {
    reportCodexReplayError(error);
    return true;
  }
}

function dispatchCodexReplayResponse(message) {
  if (!codexReplay) return false;
  try {
    const result = codexReplay.handleResponse(message);
    if (result && typeof result.then === 'function') {
      void result.catch(reportCodexReplayError);
      return true;
    }
    return result === true;
  } catch (error) {
    reportCodexReplayError(error);
    return true;
  }
}

function appendRolloutRecord(threadId, record) {
  if (process.env.CANOPY_E2E_CODEX_ROLLOUT_HISTORY !== '1') return;
  if (loadState().threads[threadId]?.purpose === 'chat-summary') return;
  const rolloutPath = path.join(
    codexHome,
    'sessions',
    '2026',
    '10',
    '16',
    `rollout-2026-10-16T00-00-00-${threadId}.jsonl`,
  );
  mkdirSync(path.dirname(rolloutPath), { recursive: true });
  if (!existsSync(rolloutPath)) {
    appendFileSync(
      rolloutPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
      'utf8',
    );
  }
  appendFileSync(rolloutPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function appendRolloutEvent(threadId, payload) {
  appendRolloutRecord(threadId, { type: 'event_msg', payload });
}

function recordSteeredInputPickup(params) {
  if (typeof params.clientUserMessageId !== 'string') return;
  appendRolloutEvent(params.threadId, {
    type: 'item_completed',
    item: {
      type: 'userMessage',
      client_id: params.clientUserMessageId,
    },
  });
}

async function sendRespectingStdoutBackpressure(message) {
  const accepted = process.stdout.write(`${JSON.stringify(message)}\n`);
  log({ direction: 'server', message });
  if (!accepted) await once(process.stdout, 'drain');
}

async function emitEventPressureTurn(threadId, turnId) {
  await sendRespectingStdoutBackpressure({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  const items = [];
  for (let index = 0; index < 48; index += 1) {
    const marker = `CANOPY-EVENT-PRESSURE-${String(index).padStart(2, '0')}`;
    const item = {
      type: 'agentMessage',
      id: `pressure-message-${turnId}-${index}`,
      text: `${marker} ${'x'.repeat(2 * 1024)}`,
      phase: 'final_answer',
    };
    items.push(item);
    await sendRespectingStdoutBackpressure({
      method: 'item/completed',
      params: { threadId, turnId, item },
    });
  }
  // Progress-only notifications: each changes nothing durable but activity.
  const planUpdates = Number(
    process.env.CANOPY_E2E_CODEX_PRESSURE_PLAN_UPDATES ?? '0',
  );
  for (let index = 0; index < planUpdates; index += 1) {
    await sendRespectingStdoutBackpressure({
      method: 'turn/plan/updated',
      params: {
        threadId,
        turnId,
        explanation: null,
        plan: [{ step: 'Report pressure status', status: 'inProgress' }],
      },
    });
  }
  await sendRespectingStdoutBackpressure({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, items, status: 'completed', error: null },
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath) {
  while (!existsSync(filePath)) {
    await sleep(10);
  }
}

/**
 * Replays a performance-harness event script: chunks of app-server
 * notifications, each released by its gate. A gate directory's `mode` file
 * holds `auto` (wait the chunk's `delayMs`) or `manual` (wait for the
 * harness to create `release-<index>`). After a chunk's notifications are
 * written, `emitted-<index>` tells the harness; `done` follows the last one.
 */
function requestPerfScriptTool(threadId, turnId, toolCall, suffix) {
  return new Promise((resolve) => {
    const callId = `perf-${suffix}-${turnId}`;
    const requestId = `request-${callId}`;
    pendingToolCalls.set(requestId, {
      threadId,
      turnId,
      tool: toolCall.tool,
      callId,
      phase: 'perf-script',
      resolve,
    });
    send({
      id: requestId,
      method: 'item/tool/call',
      params: {
        threadId,
        turnId,
        callId,
        namespace: null,
        tool: toolCall.tool,
        arguments: toolCall.arguments ?? {},
      },
    });
  });
}

async function emitPerfScriptTurn(threadId, turnId, script) {
  const gateDir = script.gateDir;
  const mode = readFileSync(path.join(gateDir, 'mode'), 'utf8').trim();
  await sendRespectingStdoutBackpressure({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  writeFileSync(path.join(gateDir, 'started'), `${turnId}\n`, 'utf8');
  for (const [index, chunk] of script.chunks.entries()) {
    if (mode === 'manual') {
      await waitForFile(path.join(gateDir, `release-${index}`));
    } else {
      await sleep(chunk.delayMs ?? 0);
    }
    // A tool call is a request: wait for the client's answer, in order.
    for (const [call, toolCall] of (chunk.toolCalls ?? []).entries())
      await requestPerfScriptTool(
        threadId,
        turnId,
        toolCall,
        `${index}-${call}`,
      );
    for (const notification of chunk.notifications ?? []) {
      const params = { threadId, ...notification.params };
      if (notification.method === 'turn/completed') {
        params.turn = { ...params.turn, id: turnId };
      } else {
        params.turnId = turnId;
      }
      await sendRespectingStdoutBackpressure({
        method: notification.method,
        params,
      });
    }
    writeFileSync(path.join(gateDir, `emitted-${index}`), '', 'utf8');
  }
  writeFileSync(path.join(gateDir, 'done'), `${turnId}\n`, 'utf8');
}

function threadRecord(threadId, cwd, items = []) {
  return {
    id: threadId,
    cwd,
    items,
    selectedCapabilityRoots: [],
    dynamicTools: [],
  };
}

function threadPayload(thread) {
  const now = Math.floor(Date.now() / 1000);
  return {
    thread: {
      id: thread.id,
      preview: '',
      ephemeral: false,
      modelProvider: 'canopy-e2e',
      createdAt: now,
      updatedAt: now,
      status: { type: 'idle' },
      path: null,
      cwd: thread.cwd,
      cliVersion: 'canopy-e2e',
      source: 'vscode',
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: 'gpt-6-sol',
    modelProvider: 'canopy-e2e',
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    activePermissionProfile: null,
    reasoningEffort: 'high',
    multiAgentMode: 'explicitRequestOnly',
    initialTurnsPage: null,
  };
}

// The app-server reports a steered input inside the turn it joined, as a
// userMessage item that echoes the client's id. Main treats that item as the
// pickup that writes the steered message to the transcript.
function emitSteeredInputPickup(params, turnId) {
  if (typeof params.clientUserMessageId !== 'string') return;
  recordSteeredInputPickup(params);
  if (process.env.CANOPY_E2E_CODEX_DROP_STEER_PICKUP === '1') return;
  send({
    method: 'item/completed',
    params: {
      threadId: params.threadId,
      turnId,
      item: {
        type: 'userMessage',
        id: `steer-input-${params.clientUserMessageId}`,
        clientId: params.clientUserMessageId,
        content: params.input,
      },
    },
  });
}

function emitCompletedTurn(
  threadId,
  turnId,
  text = reply,
  tokenUsage = {
    total: {
      totalTokens: 12,
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: 12,
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 4,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: 200000,
  },
  announceStart = true,
) {
  const requestedHoldPath = process.env.CANOPY_E2E_CODEX_HOLD_ROOT_TURN_FILE;
  const holdPath =
    requestedHoldPath &&
    loadState().threads[threadId]?.purpose === 'chat-summary'
      ? undefined
      : requestedHoldPath;
  const holdEnabled = Boolean(holdPath);
  const completionKey = `${threadId}\u0000${turnId}`;
  if (
    holdEnabled &&
    (scheduledTurnCompletions.has(completionKey) ||
      completedTurns.has(completionKey))
  )
    return;
  if (announceStart) {
    send({
      method: 'turn/started',
      params: {
        threadId,
        turn: { id: turnId, items: [], status: 'inProgress', error: null },
      },
    });
  }
  const complete = () => {
    if (holdEnabled) {
      if (completedTurns.has(completionKey)) return;
      completedTurns.add(completionKey);
    }
    emitCompletedTurnItems(threadId, turnId, text, tokenUsage);
  };
  if (!holdPath || existsSync(holdPath)) {
    complete();
    return;
  }
  scheduledTurnCompletions.add(completionKey);
  const barrier = setInterval(() => {
    if (!existsSync(holdPath)) return;
    clearInterval(barrier);
    scheduledTurnCompletions.delete(completionKey);
    rmSync(holdPath, { force: true });
    complete();
  }, 25);
}

function emitCompletedTurnItems(threadId, turnId, text, tokenUsage) {
  const item = {
    type: 'agentMessage',
    id: `message-${turnId}`,
    text,
    phase: 'final_answer',
  };
  send({
    method: 'item/started',
    params: { threadId, turnId, item: { ...item, text: '' } },
  });
  send({
    method: 'item/agentMessage/delta',
    params: {
      threadId,
      turnId,
      itemId: item.id,
      delta: text,
    },
  });
  send({
    method: 'item/completed',
    params: { threadId, turnId, item },
  });
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      tokenUsage,
    },
  });
  appendRolloutEvent(threadId, { type: 'task_complete', turn_id: turnId });
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, items: [item], status: 'completed', error: null },
    },
  });
}

// Staged streaming: emit one batch of agent messages, hold the turn open at a
// filesystem barrier, then emit a second batch and complete. Lets UI specs
// assert live pipeline transcript streaming while the turn is provably still
// in progress.
function emitStagedTurn(threadId, turnId) {
  const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
  // A resumed Codex thread can emit its previous turn's final usage snapshot
  // after turn/start returns but before the new turn/started notification.
  // Keep this deliberately large so accidental accounting is unmistakable.
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId: 'e2e-turn-before-resume',
      tokenUsage: {
        total: {
          totalTokens: 748_126,
          inputTokens: 700_000,
          cachedInputTokens: 40_000,
          outputTokens: 8_126,
          reasoningOutputTokens: 2_000,
        },
        last: {
          totalTokens: 81_659,
          inputTokens: 75_000,
          cachedInputTokens: 4_000,
          outputTokens: 2_659,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 258_400,
      },
    },
  });
  send({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  const emitStageMessage = (index) => {
    send({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'agentMessage',
          id: `staged-${turnId}-${index}`,
          text: `E2E_CODEX_STREAM_${String(index).padStart(3, '0')}`,
          phase: 'final_answer',
        },
      },
    });
  };
  let index = 0;
  const phaseOne = setInterval(() => {
    emitStageMessage(index);
    index += 1;
    if (index < 8) return;
    clearInterval(phaseOne);
    // Live token usage while the turn is held open, so audit-trail specs can
    // assert running-entry accuracy, not just transcript visibility.
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: {
          total: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 16,
            outputTokens: 40,
            reasoningOutputTokens: 8,
          },
          last: {
            totalTokens: 120,
            inputTokens: 80,
            cachedInputTokens: 16,
            outputTokens: 40,
            reasoningOutputTokens: 8,
          },
          modelContextWindow: 200000,
        },
      },
    });
    const waitForRelease = setInterval(() => {
      if (!releasePath || !existsSync(releasePath)) return;
      clearInterval(waitForRelease);
      for (; index < 16; index += 1) {
        emitStageMessage(index);
      }
      emitCompletedTurn(threadId, turnId, reply, {
        // Codex reports thread-cumulative totals. This second response adds
        // 12 tokens to the 120-token snapshot emitted while the turn was
        // parked, while `last` describes only this latest response.
        total: {
          totalTokens: 132,
          inputTokens: 88,
          cachedInputTokens: 16,
          outputTokens: 44,
          reasoningOutputTokens: 8,
        },
        last: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 0,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 200000,
      });
    }, 50);
  }, 40);
}

function emitFailedTurn(threadId, turnId, error) {
  send({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'failed', error },
    },
  });
}

// Real Codex reports a fatal turn error as a non-retrying `error`
// notification and then still finishes the turn: core's `on_task_finished`
// emits the error before TurnComplete, and the app-server sends
// `turn/completed` with status `failed` carrying that error as the turn's
// last error.
function emitNonRetryingTurnError(threadId, turnId, error) {
  send({
    method: 'error',
    params: { threadId, turnId, willRetry: false, error },
  });
  send({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'failed', error },
    },
  });
}

// A `reasoning` item is portable only when it carries no provider-private
// payload: OpenAI accepts an empty `content` array and its own
// `encrypted_content`, and rejects anything another provider wrote.
function findForeignReasoningItem(items) {
  const list = Array.isArray(items) ? items : [];
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    if (!item || typeof item !== 'object' || item.type !== 'reasoning') {
      continue;
    }
    const hasPopulatedContent =
      Array.isArray(item.content) && item.content.length > 0;
    const hasEncryptedContent =
      item.encrypted_content !== undefined && item.encrypted_content !== null;
    if (hasPopulatedContent || hasEncryptedContent) {
      return { index, item };
    }
  }
  return null;
}

function foreignReasoningError(index) {
  return {
    message:
      `[ArrayParam] [input[${index}].content] [array_above_max_length] ` +
      `Invalid 'input[${index}].content': array too long. Expected an array ` +
      `with maximum length 0, but got an array with length 1.`,
  };
}

function gatewayReasoningItem(turnId) {
  return {
    type: 'reasoning',
    id: `reasoning-${turnId}`,
    summary: [],
    content: [
      {
        type: 'reasoning_text',
        text: 'The user is asking me to say "hi" in 3 languages…',
      },
    ],
    encrypted_content: null,
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

const pendingToolCalls = new Map();
const pendingMcpElicitations = new Map();
let asyncQuestionRetrySteerCount = 0;

function emitDynamicToolCall(threadId, turnId, tool, args, phase) {
  const callId = `${phase}-${turnId}`;
  const requestId = `request-${callId}`;
  pendingToolCalls.set(requestId, { threadId, turnId, tool, callId, phase });
  send({
    id: requestId,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      callId,
      namespace: null,
      tool,
      arguments: args,
    },
  });
}

function emitDynamicToolCompleted(pending, result) {
  send({
    method: 'item/completed',
    params: {
      threadId: pending.threadId,
      turnId: pending.turnId,
      item: {
        type: 'dynamicToolCall',
        id: pending.callId,
        namespace: null,
        tool: pending.tool,
        arguments: {},
        status: 'completed',
        contentItems: result?.contentItems ?? [],
        success: result?.success !== false,
      },
    },
  });
}

function extractDeferredRef(result) {
  const text = (result?.contentItems ?? [])
    .map((item) => item?.text ?? '')
    .join('\n');
  const match = text.match(/"ref"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? process.env.CANOPY_E2E_CODEX_DEFERRED_REF ?? '';
}

function handleToolResponse(message) {
  const pending = pendingToolCalls.get(String(message.id));
  if (!pending) return false;
  pendingToolCalls.delete(String(message.id));
  log({ direction: 'client-tool-result', message });
  emitDynamicToolCompleted(pending, message.result);
  if (pending.resolve) {
    pending.resolve(message.result);
    return true;
  }

  if (pending.phase === 'auto-archive-held') {
    const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
    const barrier = setInterval(() => {
      if (!releasePath || !existsSync(releasePath)) return;
      clearInterval(barrier);
      rmSync(releasePath, { force: true });
      emitCompletedTurn(
        pending.threadId,
        pending.turnId,
        reply,
        undefined,
        false,
      );
    }, 25);
  } else if (pending.phase === 'search') {
    const ref = extractDeferredRef(message.result);
    emitDynamicToolCall(
      pending.threadId,
      pending.turnId,
      'canopy_load_deferred_tools',
      { items: [{ ref }] },
      'load',
    );
  } else if (
    pending.phase === 'auto-archive' ||
    pending.phase === 'auto-archive-question'
  ) {
    if (pending.phase === 'auto-archive-question') {
      const item = {
        id: `question-${pending.turnId}`,
        type: 'agentMessage',
        text: 'Which scope?\n- Focused\n- Full',
        phase: 'final_answer',
        delivery: 'async',
        questions: [{ title: 'Which scope?', options: ['Focused', 'Full'] }],
      };
      send({
        method: 'item/completed',
        params: {
          threadId: pending.threadId,
          turnId: pending.turnId,
          item,
        },
      });
    }
    setTimeout(() => {
      emitCompletedTurn(
        pending.threadId,
        pending.turnId,
        reply,
        undefined,
        false,
      );
    }, 3_000);
  }
  return true;
}

// CAN-3069: hold both calls open until the test has observed their live rows.
function emitRemoteToolCalls(threadId, turnId) {
  send({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  const items = [
    {
      type: 'dynamicToolCall',
      id: `graph-${turnId}`,
      tool: 'canopy_query_code_graph',
      arguments: { query: 'remote-caller' },
      status: 'inProgress',
      contentItems: [],
      success: null,
    },
    {
      type: 'mcpToolCall',
      id: `mcp-${turnId}`,
      server: 'fixture',
      tool: 'query',
      arguments: { query: 'remote-error' },
      status: 'inProgress',
      result: null,
      error: null,
    },
  ];
  for (const item of items)
    send({ method: 'item/started', params: { threadId, turnId, item } });
  const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
  const waiting = setInterval(() => {
    if (!releasePath || !existsSync(releasePath)) return;
    clearInterval(waiting);
    rmSync(releasePath, { force: true });
    const completed = [
      {
        ...items[0],
        status: 'completed',
        success: true,
        contentItems: [{ type: 'inputText', text: 'Found remote caller' }],
      },
      {
        ...items[1],
        status: 'failed',
        error: { message: 'Remote lookup failed' },
      },
    ];
    for (const item of completed)
      send({ method: 'item/completed', params: { threadId, turnId, item } });
    emitCompletedTurn(threadId, turnId, reply, undefined, false);
  }, 25);
}

function emitMcpElicitation(threadId, turnId) {
  const itemId = `mcp-call-${turnId}`;
  const requestId = `request-mcp-elicitation-${turnId}`;
  const item = {
    type: 'mcpToolCall',
    id: itemId,
    server: 'fixture-server',
    tool: 'fixture_mutation',
    status: 'inProgress',
    arguments: { value: 'accept-me' },
    result: null,
    error: null,
  };
  pendingMcpElicitations.set(requestId, { threadId, turnId, item });
  send({
    method: 'turn/started',
    params: {
      threadId,
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  send({
    method: 'item/started',
    params: { threadId, turnId, item },
  });
  send({
    id: requestId,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId,
      turnId,
      serverName: item.server,
      mode: 'form',
      message: 'Approve the fixture MCP mutation?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        codex_mcp_tool_call_id: itemId,
      },
    },
  });
}

function handleMcpElicitationResponse(message) {
  const pending = pendingMcpElicitations.get(String(message.id));
  if (!pending) return false;
  pendingMcpElicitations.delete(String(message.id));
  log({ direction: 'client-mcp-elicitation-result', message });
  if (message.result?.action !== 'accept') {
    emitFailedTurn(pending.threadId, pending.turnId, {
      message: 'MCP elicitation was not accepted',
    });
    return true;
  }
  send({
    method: 'item/completed',
    params: {
      threadId: pending.threadId,
      turnId: pending.turnId,
      item: {
        ...pending.item,
        status: 'completed',
        result: {
          content: [{ type: 'text', text: 'fixture mutation accepted' }],
          structuredContent: null,
        },
      },
    },
  });
  emitCompletedTurn(pending.threadId, pending.turnId);
  return true;
}

function allocateThread(state, params, items = []) {
  const threadId = `e2e-thread-${state.nextThread++}`;
  const thread = threadRecord(threadId, params?.cwd ?? process.cwd(), items);
  thread.selectedCapabilityRoots = params?.selectedCapabilityRoots ?? [];
  thread.dynamicTools = params?.dynamicTools ?? [];
  thread.config = params?.config ?? {};
  if (isChatSummaryThreadStartParams(params)) thread.purpose = 'chat-summary';
  state.threads[threadId] = thread;
  loadedThreadIds.add(threadId);
  saveState(state);
  return thread;
}

function emitMcpStartup(thread) {
  for (const name of Object.keys(thread.config?.mcp_servers ?? {})) {
    send({
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: thread.id,
        name,
        status: 'starting',
        error: null,
        failureReason: null,
      },
    });
    send({
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: thread.id,
        name,
        status: 'ready',
        error: null,
        failureReason: null,
      },
    });
  }
}

// The chat-summary helper quotes the user's message, so a mode keyed on prompt
// text would otherwise script the summary as if it were the conversation.
// Summary turns are background metadata on their own ephemeral thread: answer
// them plainly in every mode.
function isChatSummaryTurn(thread, params) {
  return (
    thread.purpose === 'chat-summary' || isChatSummaryTurnInput(params.input)
  );
}

function answerChatSummaryTurn(state, thread, message) {
  const input = message.params?.input;
  thread.purpose = 'chat-summary';
  thread.items.push(...(Array.isArray(input) ? input : []));
  // A separate counter keeps conversation turn ids (`e2e-turn-N`) independent
  // of whether the background summary started first.
  const summaryTurn = state.nextSummaryTurn ?? 1;
  state.nextSummaryTurn = summaryTurn + 1;
  const turnId = `e2e-summary-turn-${summaryTurn}`;
  saveState(state);
  send({
    id: message.id,
    result: {
      turn: { id: turnId, items: [], status: 'inProgress', error: null },
    },
  });
  setTimeout(
    () => emitCompletedTurn(thread.id, turnId, CHAT_SUMMARY_FIXTURE_REPLY),
    10,
  );
}

function handleRequest(message) {
  if (!message || typeof message !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(message, 'method')) {
    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      log({ direction: 'client-response', message });
    }
    if (mode === 'replay' && dispatchCodexReplayResponse(message)) {
      return;
    }
    if (!handleMcpElicitationResponse(message)) {
      handleToolResponse(message);
    }
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    log({ direction: 'client-notification', message });
    return;
  }

  log({ direction: 'client', message });
  const state = loadState();
  const params = message.params ?? {};

  switch (message.method) {
    case 'initialize': {
      const respond = () => {
        const response = {
          id: message.id,
          result: { userAgent: 'canopy-e2e', codexHome },
        };
        if (codexReplay) {
          // Initialization belongs to a conversation only once a non-summary
          // thread starts; summary-only app-server traffic is not replayed.
          pendingConversationInitialize = { message, response };
        }
        send(response);
      };
      // Deferred, not dropped: the handshake completes once the spec removes
      // the hold file, so a later connection can still start.
      const holdPath = process.env.CANOPY_E2E_CODEX_INITIALIZE_HOLD_PATH;
      if (!holdPath || !existsSync(holdPath)) {
        respond();
        return;
      }
      const barrier = setInterval(() => {
        if (existsSync(holdPath)) return;
        clearInterval(barrier);
        respond();
      }, 10);
      return;
    }
    case 'thread/list':
    case 'thread/backgroundTerminals/list': {
      const threadId =
        message.method === 'thread/backgroundTerminals/list'
          ? params.threadId
          : conversationThreadId;
      if (
        mode === 'replay' &&
        dispatchCodexReplayRequest(message, {
          threadId,
          cwd: state.threads[threadId]?.cwd ?? process.cwd(),
        })
      ) {
        return;
      }
      respondToCodexListRequest(message, state);
      return;
    }
    case 'thread/start': {
      const thread = allocateThread(state, params);
      const response = { id: message.id, result: threadPayload(thread) };
      if (!isChatSummaryThreadStartParams(params)) {
        conversationThreadId ??= thread.id;
      }
      if (codexReplay && !isChatSummaryThreadStartParams(params)) {
        if (pendingConversationInitialize) {
          codexReplay.recordBootstrap(
            pendingConversationInitialize.message,
            pendingConversationInitialize.response,
          );
          pendingConversationInitialize = undefined;
        }
        codexReplay.recordBootstrap(message, response);
      }
      send(response);
      emitMcpStartup(thread);
      return;
    }
    case 'thread/resume': {
      const thread = state.threads[params.threadId];
      if (
        process.env.CANOPY_E2E_CODEX_RETAIN_WRITER === 'true' &&
        thread?.writerPid &&
        thread.writerPid !== process.pid &&
        isProcessAlive(thread.writerPid)
      ) {
        send({
          id: message.id,
          error: {
            code: -32600,
            message: `thread ${params.threadId} already has an active writer`,
          },
        });
        return;
      }
      if (!thread) {
        send({
          id: message.id,
          error: {
            code: -32001,
            message:
              process.env.CANOPY_E2E_CODEX_MISSING_THREAD_ERROR ??
              `thread not found: ${String(params.threadId)}`,
          },
        });
        return;
      }
      // Mirrors a resume that races the app-server's own shutdown of the
      // thread: rejected a fixed number of times (then `thread/closed`), or
      // for as long as a hold file exists.
      const closingHoldPath = process.env.CANOPY_E2E_CODEX_CLOSING_HOLD_PATH;
      const closingResumes = Number(
        process.env.CANOPY_E2E_CODEX_CLOSING_RESUMES ?? '0',
      );
      if (
        (closingHoldPath && existsSync(closingHoldPath)) ||
        closingResumeCount < closingResumes
      ) {
        closingResumeCount += 1;
        send({
          id: message.id,
          error: {
            code: -32600,
            message: `thread ${params.threadId} is closing; retry thread/resume after the thread is closed`,
          },
        });
        if (!closingHoldPath && closingResumeCount === closingResumes) {
          setTimeout(() => {
            send({
              method: 'thread/closed',
              params: { threadId: params.threadId },
            });
          }, 50);
        }
        return;
      }
      conversationThreadId ??= thread.id;
      if (
        params.config &&
        !(
          process.env.CANOPY_E2E_CODEX_RETAIN_PROVIDER_CONFIG === 'true' &&
          loadedThreadIds.has(thread.id)
        )
      ) {
        thread.config = params.config;
        saveState(state);
      }
      loadedThreadIds.add(thread.id);
      const result = threadPayload(thread);
      if (process.env.CANOPY_E2E_CODEX_UNICODE_RESUME === 'true') {
        result.thread.preview =
          'Historical Mermaid: stateDiagram-v2\u2028classDef x fill:red\u2029[*] --> A';
      }
      send({ id: message.id, result });
      emitMcpStartup(thread);
      return;
    }
    case 'thread/fork': {
      if (process.env.CANOPY_E2E_CODEX_FORK_FAIL === 'true') {
        send({
          id: message.id,
          error: { code: -32001, message: 'Fixture fork unavailable' },
        });
        return;
      }
      const source = state.threads[params.threadId];
      if (!source) {
        send({
          id: message.id,
          error: {
            code: -32001,
            message: `thread not found: ${String(params.threadId)}`,
          },
        });
        return;
      }
      const thread = allocateThread(
        state,
        params,
        structuredClone(source.items),
      );
      thread.selectedCapabilityRoots = structuredClone(
        source.selectedCapabilityRoots ?? [],
      );
      thread.dynamicTools = structuredClone(source.dynamicTools ?? []);
      thread.config = structuredClone(source.config ?? {});
      state.threads[thread.id] = thread;
      saveState(state);
      const forkDelay = Number(process.env.CANOPY_E2E_CODEX_FORK_DELAY_MS ?? 0);
      if (forkDelay > 0) {
        setTimeout(
          () => send({ id: message.id, result: threadPayload(thread) }),
          forkDelay,
        );
      } else {
        send({ id: message.id, result: threadPayload(thread) });
      }
      return;
    }
    case 'thread/inject_items': {
      if (failInject) {
        send({
          id: message.id,
          error: { code: -32002, message: 'fixture injection failure' },
        });
        return;
      }
      const thread = state.threads[params.threadId];
      if (!thread) {
        send({
          id: message.id,
          error: { code: -32001, message: 'thread not found' },
        });
        return;
      }
      thread.items.push(...(Array.isArray(params.items) ? params.items : []));
      saveState(state);
      send({ id: message.id, result: {} });
      return;
    }
    case 'turn/start': {
      const thread = state.threads[params.threadId];
      if (thread && process.env.CANOPY_E2E_CODEX_RETAIN_WRITER === 'true') {
        thread.writerPid = process.pid;
        saveState(state);
      }
      if (!thread) {
        send({
          id: message.id,
          error: { code: -32001, message: 'thread not found' },
        });
        return;
      }
      if (isChatSummaryTurn(thread, params)) {
        answerChatSummaryTurn(state, thread, message);
        return;
      }
      if (
        mode === 'stale-proxy-route-persistent' ||
        (mode === 'stale-proxy-route-once' && !state.staleProxyRouteFailed)
      ) {
        state.staleProxyRouteFailed = true;
        const turnId = `e2e-turn-${state.nextTurn++}`;
        const input = Array.isArray(params.input) ? params.input : [];
        thread.items.push(...input);
        saveState(state);
        // Mirror a failed Responses request that already persisted its input.
        const rolloutPath = path.join(
          codexHome,
          'sessions',
          '2026',
          '08',
          '20',
          `rollout-${thread.id}.jsonl`,
        );
        if (existsSync(rolloutPath)) {
          const payload = {
            type: 'message',
            role: 'user',
            content: input
              .filter((item) => item.type === 'text')
              .map((item) => ({ type: 'input_text', text: item.text })),
          };
          appendFileSync(
            rolloutPath,
            `${JSON.stringify({ type: 'response_item', payload })}\n`,
          );
        }
        send({
          id: message.id,
          result: {
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        setTimeout(
          () =>
            emitFailedTurn(thread.id, turnId, {
              message:
                'HTTP 404: AI Credits proxy route is no longer available.',
            }),
          10,
        );
        return;
      }
      const foreignReasoning = strictReasoning
        ? findForeignReasoningItem([
            ...(Array.isArray(thread.items) ? thread.items : []),
            ...(Array.isArray(params.input) ? params.input : []),
          ])
        : null;
      if (foreignReasoning) {
        const rejectedTurnId = `e2e-turn-${state.nextTurn++}`;
        appendRolloutEvent(thread.id, {
          type: 'task_started',
          turn_id: rejectedTurnId,
        });
        // Real Codex persists the user input to the rollout before the model
        // call, so a turn rejected by the Responses API still leaves its input
        // in thread history. Retain it here too: returning before this push
        // would hide prompt duplication on the rebuild path, where the client
        // reconstructs from history and then re-sends the same message.
        thread.items.push(...(Array.isArray(params.input) ? params.input : []));
        saveState(state);
        send({
          id: message.id,
          result: {
            turn: {
              id: rejectedTurnId,
              items: [],
              status: 'inProgress',
              error: null,
            },
          },
        });
        setTimeout(
          () =>
            emitFailedTurn(
              thread.id,
              rejectedTurnId,
              foreignReasoningError(foreignReasoning.index),
            ),
          10,
        );
        return;
      }
      thread.items.push(...(Array.isArray(params.input) ? params.input : []));
      const turnId = `e2e-turn-${state.nextTurn++}`;
      appendRolloutEvent(thread.id, { type: 'task_started', turn_id: turnId });
      const serializedInput = JSON.stringify(params.input);
      const accountCutoverPipelineTurn =
        serializedInput.includes(
          'Exercise the in-process Codex pipeline runtime.',
        ) ||
        serializedInput.includes('Hold this chat for Codex sign-in.') ||
        thread.accountCutoverPipeline === true;
      if (accountCutoverPipelineTurn) thread.accountCutoverPipeline = true;
      // A real gateway-backed Codex turn retains the upstream provider's
      // reasoning response item in thread history. Seed that state only for
      // the strict portability scenario so a later native resume reproduces
      // the observed Responses API rejection instead of passing on an empty
      // fake thread.
      if (
        strictReasoning &&
        typeof params.model === 'string' &&
        params.model.startsWith('deepseek/')
      ) {
        thread.items.push(gatewayReasoningItem(turnId));
      }
      saveState(state);
      if (
        mode === 'replay' &&
        dispatchCodexReplayRequest(message, {
          threadId: thread.id,
          turnId,
          cwd: thread.cwd,
        })
      ) {
        return;
      }
      if (mode === 'watcher-start-held') {
        const releasePath =
          process.env.CANOPY_E2E_CODEX_TURN_START_RELEASE_PATH;
        const turn = {
          id: turnId,
          items: [],
          status: 'inProgress',
          error: null,
        };
        log({
          direction: 'turn-start-held',
          threadId: thread.id,
          turnId,
        });
        const barrier = setInterval(() => {
          if (!releasePath || !existsSync(releasePath)) return;
          clearInterval(barrier);
          rmSync(releasePath, { force: true });
          watcherStartTurnIds.set(thread.id, turnId);
          log({
            direction: 'turn-start-released',
            threadId: thread.id,
            turnId,
          });
          send({ id: message.id, result: { turn } });
          send({
            method: 'turn/started',
            params: { threadId: thread.id, turn },
          });
        }, 25);
        return;
      }
      if (
        mode === 'auto-archive-async-question' &&
        serializedInput.includes('Q: Which scope?')
      ) {
        const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
        const waitForRelease = setInterval(() => {
          if (!releasePath || !existsSync(releasePath)) return;
          clearInterval(waitForRelease);
          rmSync(releasePath, { force: true });
          send({
            id: message.id,
            result: {
              turn: {
                id: turnId,
                items: [],
                status: 'inProgress',
                error: null,
              },
            },
          });
          send({
            method: 'turn/started',
            params: {
              threadId: thread.id,
              turn: {
                id: turnId,
                items: [],
                status: 'inProgress',
                error: null,
              },
            },
          });
          setTimeout(() => emitCompletedTurn(thread.id, turnId), 10);
        }, 25);
        return;
      }
      send({
        id: message.id,
        result: {
          turn: { id: turnId, items: [], status: 'inProgress', error: null },
        },
      });
      if (mode === 'watcher-steer-late-refusal') {
        const conversationTurnCount =
          (lateSteerConversationTurnCounts.get(thread.id) ?? 0) + 1;
        lateSteerConversationTurnCounts.set(thread.id, conversationTurnCount);
        if (conversationTurnCount === 1) {
          const turn = {
            id: turnId,
            items: [],
            status: 'inProgress',
            error: null,
          };
          const rootTurnDelayMs = Number(
            process.env.CANOPY_E2E_CODEX_ROOT_TURN_DELAY_MS ?? 50_000,
          );
          send({
            method: 'turn/started',
            params: { threadId: thread.id, turn },
          });
          log({
            direction: 'turn-start-held-for-late-steer',
            threadId: thread.id,
            turnId,
            delayMs: rootTurnDelayMs,
          });
          setTimeout(
            () => emitCompletedTurn(thread.id, turnId, reply, undefined, false),
            rootTurnDelayMs,
          );
        } else {
          setTimeout(() => emitCompletedTurn(thread.id, turnId), 10);
        }
        return;
      }
      if (mode === 'proxy-quota-notice') {
        send({
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              rateLimitReachedType: 'rate_limit_reached',
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: Date.now() + 1000,
              },
            },
          },
        });
      }
      if (mode === 'usage-limit-banner') {
        // CAN-4564: the hosted account reports the reached window in epoch
        // seconds, then the turn fails with OpenAI's full upsell text. The
        // desktop must show only the banner, with the reset time.
        send({
          method: 'account/rateLimits/updated',
          params: {
            rateLimits: {
              rateLimitReachedType: 'rate_limit_reached',
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: Math.floor(Date.now() / 1000) + 60 * 60,
              },
            },
          },
        });
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        emitNonRetryingTurnError(thread.id, turnId, {
          message:
            "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more.",
          codexErrorInfo: 'usageLimitExceeded',
        });
        return;
      }
      if (
        (mode === 'usage-limit-resume' && accountAtStartup !== loginAccount) ||
        (mode === 'proxy-quota' &&
          !existsSync(process.env.CANOPY_E2E_CODEX_RELEASE_PATH))
      ) {
        // Native Codex quota errors arrive as a non-retrying error notification
        // followed by turn/completed with status failed carrying the same
        // error. Keep this distinct from an HTTP 429 mock.
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        if (mode === 'proxy-quota') {
          send({
            method: 'item/started',
            params: {
              threadId: thread.id,
              turnId,
              item: {
                id: 'before-quota',
                type: 'agentMessage',
                text: 'Work before quota.',
              },
            },
          });
        }
        emitNonRetryingTurnError(thread.id, turnId, {
          message: "You've hit your usage limit.",
          codexErrorInfo: 'usageLimitExceeded',
        });
        return;
      }
      if (
        mode === 'deferred' &&
        !params.input?.some?.(
          (item) =>
            JSON.stringify(item).includes('Requested items now enabled') ||
            JSON.stringify(item).includes('The requested tools are available.'),
        )
      ) {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        emitDynamicToolCall(
          thread.id,
          turnId,
          'canopy_search_deferred_tools',
          { queries: [{ text: 'Deferred Reload Fixture', kinds: ['mcp'] }] },
          'search',
        );
      } else if (
        mode === 'auto-archive-held' ||
        mode === 'auto-archive-tool' ||
        mode === 'auto-archive-async-question'
      ) {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        emitDynamicToolCall(
          thread.id,
          turnId,
          mode === 'auto-archive-held' &&
            thread.dynamicTools.some((tool) =>
              tool.name.startsWith('canopy_app_advisor_'),
            )
            ? 'canopy_app_advisor_set_auto_archive'
            : 'canopy_set_auto_archive',
          { enabled: !serializedInput.includes('Disable using tool') },
          mode === 'auto-archive-held'
            ? 'auto-archive-held'
            : mode === 'auto-archive-async-question'
              ? 'auto-archive-question'
              : 'auto-archive',
        );
      } else if (
        mode === 'structured-retry' &&
        !JSON.stringify(params.input).includes(
          'Your previous response failed JSON Schema validation.',
        )
      ) {
        setTimeout(
          () =>
            emitFailedTurn(thread.id, turnId, {
              message: 'Response does not match output schema',
            }),
          10,
        );
      } else if (
        ['transient-capacity', 'transient-cyber-access'].includes(mode) &&
        !thread.capacityFailed &&
        (serializedInput.includes('Exercise transient retry') ||
          serializedInput.includes(
            'Exercise the in-process Codex pipeline runtime.',
          ) ||
          accountCutoverPipelineTurn)
      ) {
        thread.capacityFailed = true;
        saveState(state);
        setTimeout(() => {
          send({
            method: 'turn/started',
            params: {
              threadId: thread.id,
              turn: {
                id: turnId,
                items: [],
                status: 'inProgress',
                error: null,
              },
            },
          });
          send({
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: 'commandExecution',
                id: `work-${turnId}`,
                command: 'echo checked',
                cwd: process.cwd(),
                status: 'completed',
                aggregatedOutput: 'checked',
                exitCode: 0,
              },
            },
          });
          send({
            method: 'turn/completed',
            params: {
              threadId: thread.id,
              turn: {
                id: turnId,
                items: [],
                status: 'failed',
                error:
                  mode === 'transient-cyber-access'
                    ? {
                        message: JSON.stringify(
                          {
                            type: 'error',
                            error: {
                              type: 'invalid_request_error',
                              code: 'unsupported_parameter',
                              message:
                                'The access_programs parameter is not enabled for this organization.',
                              param: 'access_programs.cyber',
                            },
                            status: 400,
                          },
                          null,
                          2,
                        ),
                        codexErrorInfo: 'other',
                      }
                    : {
                        message:
                          'Selected model is at capacity. Please try a different model.',
                        codexErrorInfo: 'serverOverloaded',
                      },
              },
            },
          });
          // Tiger's root failure was followed by a child's final output.
          setTimeout(
            () =>
              send({
                method: 'item/completed',
                params: {
                  threadId: 'late-child-thread',
                  turnId: 'late-child-turn',
                  item: {
                    type: 'agentMessage',
                    id: 'late-child-message',
                    text: 'Child review complete.',
                    phase: 'final_answer',
                  },
                },
              }),
            100,
          );
        }, 10);
      } else if (
        ['transient-capacity', 'transient-cyber-access'].includes(mode) &&
        thread.capacityFailed
      ) {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        send({
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId,
            item: {
              type: 'commandExecution',
              id: `recovered-command-${turnId}`,
              command: 'echo retry-command-marker',
              cwd: process.cwd(),
              status: 'completed',
              aggregatedOutput: 'retry-command-marker',
              exitCode: 0,
            },
          },
        });
        setTimeout(
          () => emitCompletedTurn(thread.id, turnId, reply, undefined, false),
          10,
        );
      } else if (mode === 'usage-limit') {
        setTimeout(
          () =>
            emitFailedTurn(thread.id, turnId, {
              message: 'Usage limit reached',
              codexErrorInfo: 'usageLimitExceeded',
              resetsAt: 1_800_000_000,
            }),
          10,
        );
      } else if (
        mode.startsWith('async-question') &&
        serializedInput.includes('Ask an async question')
      ) {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        const item = {
          id: `question-${turnId}`,
          type: 'agentMessage',
          text:
            mode === 'async-question-freeform'
              ? 'Which scope?'
              : 'Which scope?\n- Focused\n- Full',
          phase: 'final_answer',
          delivery: 'async',
          questions: [
            {
              title: 'Which scope?',
              options:
                mode === 'async-question-freeform' ? null : ['Focused', 'Full'],
            },
          ],
        };
        for (const method of [
          'item/started',
          'item/completed',
          'item/completed',
        ])
          send({ method, params: { threadId: thread.id, turnId, item } });
        send({
          method: 'item/completed',
          params: {
            threadId: thread.id,
            turnId,
            item: {
              id: `progress-${turnId}`,
              type: 'agentMessage',
              text: 'Continuing work before your answer.',
              phase: 'commentary',
            },
          },
        });
        if (mode === 'async-question-collapse') {
          const barrier = setInterval(() => {
            const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
            if (!releasePath || !existsSync(releasePath)) return;
            clearInterval(barrier);
            rmSync(releasePath, { force: true });
            send({
              method: 'item/completed',
              params: {
                threadId: thread.id,
                turnId,
                item: {
                  type: 'commandExecution',
                  id: `question-tool-${turnId}`,
                  command: 'echo checked',
                  cwd: process.cwd(),
                  processId: '50465',
                  status: 'completed',
                  commandActions: [],
                  aggregatedOutput: 'Checked after asking',
                  exitCode: 0,
                  durationMs: 10,
                },
              },
            });
            emitCompletedTurn(thread.id, turnId);
          }, 25);
        }
        if (mode === 'async-question-idle') {
          emitCompletedTurn(thread.id, turnId);
          setTimeout(
            () =>
              send({
                method: 'item/completed',
                params: { threadId: thread.id, turnId, item },
              }),
            10,
          );
        }
      } else if (mode === 'late-command') {
        emitCompletedTurn(thread.id, turnId);
        const releasePath = process.env.CANOPY_E2E_CODEX_RELEASE_PATH;
        const barrier = setInterval(() => {
          if (!releasePath || !existsSync(releasePath)) return;
          clearInterval(barrier);
          rmSync(releasePath, { force: true });
          send({
            method: 'item/completed',
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: 'commandExecution',
                id: `late-command-${turnId}`,
                command: 'npm run perf:desktop:smoke',
                cwd: process.cwd(),
                processId: '50465',
                status: 'completed',
                commandActions: [],
                aggregatedOutput: 'Late background command completed',
                exitCode: 0,
                durationMs: 1000,
              },
            },
          });
          log({ direction: 'late-command-emitted', turnId });
        }, 25);
      } else if (
        mode === 'event-pressure' &&
        serializedInput.includes('Report pressure status.')
      ) {
        void emitEventPressureTurn(thread.id, turnId).catch((error) => {
          log({ direction: 'pressure-error', message: String(error) });
        });
      } else if (mode === 'hang') {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
      } else if (mode === 'usage-limit-resume') {
        send({
          method: 'turn/started',
          params: {
            threadId: thread.id,
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        });
        // Codex can forward a late same-root error for an earlier turn while
        // the current provider turn continues normally.
        send({
          method: 'error',
          params: {
            threadId: thread.id,
            turnId: `stale-${turnId}`,
            willRetry: false,
            error: { message: 'Earlier Codex turn failed late.' },
          },
        });
        setTimeout(
          () => emitCompletedTurn(thread.id, turnId, reply, undefined, false),
          10,
        );
      } else if (mode === 'perf-script' && perfScriptDir) {
        const marker = /\[(Canopy-C[A-Za-z0-9_-]+)\]/.exec(
          serializedInput,
        )?.[1];
        const scriptPath = marker
          ? path.join(perfScriptDir, `${marker}.json`)
          : null;
        if (scriptPath && existsSync(scriptPath)) {
          const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
          void emitPerfScriptTurn(thread.id, turnId, script).catch((error) => {
            log({
              direction: 'perf-script-error',
              message: String(error?.stack ?? error),
            });
          });
        } else {
          setTimeout(() => emitCompletedTurn(thread.id, turnId), 10);
        }
      } else if (mode === 'remote-tool-calls') {
        emitRemoteToolCalls(thread.id, turnId);
      } else if (mode === 'mcp-elicitation') {
        emitMcpElicitation(thread.id, turnId);
      } else if (
        mode === 'staged' ||
        (mode === 'account-cutover' && accountCutoverPipelineTurn)
      ) {
        emitStagedTurn(thread.id, turnId);
      } else {
        setTimeout(() => emitCompletedTurn(thread.id, turnId), 10);
      }
      return;
    }
    case 'turn/steer':
      if (
        mode === 'replay' &&
        dispatchCodexReplayRequest(message, {
          threadId: params.threadId,
          turnId: params.expectedTurnId,
          cwd: state.threads[params.threadId]?.cwd ?? process.cwd(),
        })
      ) {
        return;
      }
      if (mode === 'watcher-steer-late-refusal') {
        const delayMs = Number(
          process.env.CANOPY_E2E_CODEX_STEER_REFUSAL_DELAY_MS ?? 35_000,
        );
        log({
          direction: 'turn-steer-refusal-held',
          threadId: params.threadId,
          turnId: params.expectedTurnId,
          delayMs,
        });
        setTimeout(() => {
          log({
            direction: 'turn-steer-refusal-replied',
            threadId: params.threadId,
            turnId: params.expectedTurnId,
          });
          send({
            id: message.id,
            error: { code: -32600, message: 'no active turn to steer' },
          });
        }, delayMs);
        return;
      }
      if (mode === 'watcher-start-held') {
        const activeTurnId = watcherStartTurnIds.get(params.threadId);
        if (!activeTurnId || params.expectedTurnId !== activeTurnId) {
          send({
            id: message.id,
            error: { code: -32600, message: 'no active turn to steer' },
          });
          return;
        }
        send({ id: message.id, result: { turnId: activeTurnId } });
        watcherStartTurnIds.delete(params.threadId);
        // The real provider correlates pickup with the admission attempt,
        // not the canonical watcher message id. Emit it before the terminal
        // so main can commit the steered input inside this same root turn.
        recordSteeredInputPickup(params);
        if (process.env.CANOPY_E2E_CODEX_DROP_STEER_PICKUP !== '1') {
          send({
            method: 'item/completed',
            params: {
              threadId: params.threadId,
              turnId: activeTurnId,
              item: {
                type: 'userMessage',
                id: `watcher-input-${activeTurnId}`,
                clientId: params.clientUserMessageId,
                content: params.input,
              },
            },
          });
        }
        emitCompletedTurn(
          params.threadId,
          activeTurnId,
          reply,
          undefined,
          false,
        );
        return;
      }
      if (mode === 'async-question-queued') {
        send({
          id: message.id,
          error: { code: -32600, message: 'no active turn to steer' },
        });
        return;
      }
      if (
        mode === 'async-question-retry' &&
        asyncQuestionRetrySteerCount === 0
      ) {
        asyncQuestionRetrySteerCount += 1;
        send({
          id: message.id,
          error: { code: -32001, message: 'ambiguous transport failure' },
        });
        return;
      }
      if (mode === 'async-question-race') {
        send({
          id: message.id,
          error: { code: -32600, message: 'no active turn to steer' },
        });
        emitCompletedTurn(params.threadId, params.expectedTurnId);
        return;
      }
      send({ id: message.id, result: { turnId: params.expectedTurnId } });
      emitSteeredInputPickup(params, params.expectedTurnId);
      if (mode === 'async-question-timeline-active') {
        const barrier = setInterval(() => {
          if (!existsSync(process.env.CANOPY_E2E_CODEX_RELEASE_PATH)) return;
          clearInterval(barrier);
          emitCompletedTurn(params.threadId, params.expectedTurnId);
        }, 10);
        return;
      }
      emitCompletedTurn(params.threadId, params.expectedTurnId);
      return;
    case 'turn/interrupt':
      if (
        mode === 'replay' &&
        dispatchCodexReplayRequest(message, {
          threadId: params.threadId,
          turnId: params.turnId,
          cwd: state.threads[params.threadId]?.cwd ?? process.cwd(),
        })
      ) {
        return;
      }
      send({ id: message.id, result: {} });
      if (process.env.CANOPY_E2E_CODEX_OMIT_INTERRUPT_COMPLETION === '1')
        return;
      send({
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: {
            id: params.turnId,
            items: [],
            status: 'interrupted',
            error: null,
          },
        },
      });
      return;
    case 'thread/read': {
      const thread = state.threads[params.threadId];
      send({
        id: message.id,
        result: thread ? { thread: threadPayload(thread).thread } : null,
      });
      return;
    }
    case 'config/read': {
      // Servers the "user" configured globally, which every new thread
      // would inherit unless the request disables them.
      const ambient = process.env.CANOPY_E2E_CODEX_AMBIENT_MCP_SERVERS;
      send({
        id: message.id,
        result: {
          config: { mcp_servers: ambient ? JSON.parse(ambient) : {} },
          origins: {},
          layers: null,
        },
      });
      return;
    }
    case 'thread/delete':
      delete state.threads[params.threadId];
      saveState(state);
      send({ id: message.id, result: {} });
      return;
    case 'thread/unsubscribe':
      // Matches codex-cli 0.159.0: the thread stays loaded, writer included.
      send({ id: message.id, result: { status: 'unsubscribed' } });
      return;
    case 'config/mcpServer/reload':
      send({ id: message.id, result: {} });
      return;
    case 'account/login/start': {
      pendingLoginId = `login-${process.pid}`;
      const result =
        params.type === 'chatgptDeviceCode'
          ? {
              type: 'chatgptDeviceCode',
              loginId: pendingLoginId,
              verificationUrl: 'https://auth.openai.com/codex/device',
              userCode: 'TEST-1234',
            }
          : {
              type: 'chatgpt',
              loginId: pendingLoginId,
              authUrl: 'https://auth.openai.com/authorize?state=synthetic-e2e',
            };
      send({ id: message.id, result });
      loginWatcher = setInterval(() => {
        if (!loginResultPath || !existsSync(loginResultPath)) return;
        const outcome = readFileSync(loginResultPath, 'utf8').trim();
        rmSync(loginResultPath, { force: true });
        clearInterval(loginWatcher);
        if (outcome === 'success' && accountPath && loginAccount) {
          writeFileSync(accountPath, `${loginAccount}\n`, 'utf8');
          if (authJsonPath) {
            writeFileSync(
              authJsonPath,
              `${JSON.stringify({ account: loginAccount })}\n`,
              'utf8',
            );
          }
        }
        send({
          method: 'account/login/completed',
          params: {
            loginId: pendingLoginId,
            success: outcome === 'success',
            error: outcome === 'success' ? null : 'Synthetic login failure',
            onboardingEntrypoint: null,
          },
        });
      }, 25);
      return;
    }
    case 'account/login/cancel':
      clearInterval(loginWatcher);
      send({ id: message.id, result: { status: 'canceled' } });
      return;
    case 'account/read': {
      const holdPath = process.env.CANOPY_E2E_CODEX_ACCOUNT_READ_HOLD_PATH;
      if (holdPath && existsSync(holdPath)) return;
      if (accountReadFailurePath && existsSync(accountReadFailurePath)) {
        rmSync(accountReadFailurePath, { force: true });
        send({
          id: message.id,
          error: { code: -32_001, message: 'Synthetic account read failure' },
        });
        return;
      }
      send({
        id: message.id,
        result: {
          account: accountAtStartup
            ? { type: 'chatgpt', email: accountAtStartup, planType: 'plus' }
            : { type: 'apiKey' },
          requiresOpenaiAuth: false,
        },
      });
      return;
    }
    case 'account/rateLimits/read':
      send({ id: message.id, result: { rateLimits: null } });
      return;
    case 'plugin/list':
      send({
        id: message.id,
        result: pluginFixture?.pluginList ?? emptyPluginList(),
      });
      return;
    case 'plugin/installed':
      send({
        id: message.id,
        result: pluginFixture?.pluginInstalled ?? emptyInstalledPlugins(),
      });
      return;
    case 'marketplace/upgrade': {
      const marketplaceName = params.marketplaceName ?? null;
      const rejected =
        typeof marketplaceName === 'string' &&
        pluginFixture?.rejectedUpgradeMarketplaceNames?.includes(
          marketplaceName,
        );
      send({
        id: message.id,
        result: rejected
          ? {
              selectedMarketplaces: [],
              upgradedRoots: [],
              errors: [
                {
                  marketplaceName,
                  message: `marketplace '${marketplaceName}' is not configured as a Git marketplace`,
                },
              ],
            }
          : {
              selectedMarketplaces:
                typeof marketplaceName === 'string' ? [marketplaceName] : [],
              upgradedRoots: [],
              errors: [],
            },
      });
      return;
    }
    case 'marketplace/add': {
      const source = String(params.source ?? 'fixture-marketplace');
      const marketplaceName = source
        .replace(/\/+$/, '')
        .split(/[/:]/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.git$/i, '');
      send({
        id: message.id,
        result: {
          marketplaceName: marketplaceName ?? 'fixture-marketplace',
          installedRoot: source,
          alreadyAdded: false,
        },
      });
      return;
    }
    case 'marketplace/remove':
      send({
        id: message.id,
        result: {
          marketplaceName: String(
            params.marketplaceName ?? 'fixture-marketplace',
          ),
          installedRoot: null,
          alreadyAdded: false,
        },
      });
      return;
    case 'skills/list':
      send({ id: message.id, result: { data: [], nextCursor: null } });
      return;
    case 'mcpServerStatus/list': {
      const thread = state.threads[params.threadId];
      const servers = thread?.config?.mcp_servers ?? {};
      send({
        id: message.id,
        result: {
          data: Object.keys(servers).map((name) => ({
            name,
            tools: { fixture_tool: {} },
            resources: [],
            resourceTemplates: [],
            authStatus: 'unsupported',
            serverInfo: { name, version: '1.0.0' },
          })),
          nextCursor: null,
        },
      });
      return;
    }
    case 'model/list': {
      // Production builds read the account's models from the app-server;
      // a release-like spec that routes delegates supplies them here.
      const listed = process.env.CANOPY_E2E_CODEX_MODEL_LIST;
      send({
        id: message.id,
        result: listed ? { data: JSON.parse(listed), nextCursor: null } : {},
      });
      return;
    }
    default:
      send({ id: message.id, result: {} });
  }
}

saveState(loadState());
const readline = createInterface({ input: process.stdin });
readline.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleRequest(JSON.parse(trimmed));
  } catch (error) {
    log({ direction: 'fixture-error', error: error?.stack ?? String(error) });
  }
});
