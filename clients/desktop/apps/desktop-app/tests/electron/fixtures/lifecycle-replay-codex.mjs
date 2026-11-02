/**
 * Content-free lifecycle replay adapter for the Codex app-server JSON-RPC
 * boundary used by Electron's stdio fixtures. This is test harness code, not a
 * production Codex client.
 */
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createGates,
  createReplayLog,
  loadReplayFixture,
  readReplayEnv,
  runReplay,
  scheduleSteps,
} from './lifecycle-replay.mjs';

const ID_KINDS = [
  'session',
  'message',
  'turn',
  'thread',
  'item',
  'task',
  'call',
  'request',
  'toolUse',
];
const ITEM_TYPES = new Set([
  'agentMessage',
  'userMessage',
  'commandExecution',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
]);
const STATUS_ITEM_TYPES = new Set([
  'commandExecution',
  'dynamicToolCall',
  'collabAgentToolCall',
]);
const ITEM_STATUSES = new Set([
  'inProgress',
  'completed',
  'failed',
  'declined',
  'interrupted',
]);
const THREAD_STATUSES = new Set(['active', 'idle', 'systemError']);
const TURN_STATUSES = new Set([
  'inProgress',
  'completed',
  'failed',
  'interrupted',
]);
const SUBAGENT_KINDS = new Set([
  'started',
  'interacted',
  'interrupted',
  'completed',
]);
const BOOTSTRAP_METHODS = new Set([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/fork',
]);
const THREAD_LIST_METHOD = 'thread/list';
const BACKGROUND_TERMINALS_LIST_METHOD = 'thread/backgroundTerminals/list';
const LIST_METHODS = new Set([
  THREAD_LIST_METHOD,
  BACKGROUND_TERMINALS_LIST_METHOD,
]);
const SERVER_REQUEST_METHODS = new Set([
  'item/tool/call',
  'item/tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);
const SERVER_REQUEST_RESPONSE_METHODS = new Set([
  ...APPROVAL_METHODS,
  'item/tool/requestUserInput',
]);
const SUPPORTED_METHODS = new Set([
  'initialize',
  'remoteControl/status/changed',
  'thread/start',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'turn/start',
  'turn/started',
  'turn/completed',
  'turn/steer',
  'turn/interrupt',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/commandExecution/outputDelta',
  'item/tool/call',
  'item/tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'serverRequest/resolved',
  'account/rateLimits/updated',
  'error',
]);
const TEMPLATE_METHODS = new Map([
  ['thread.start', 'thread/start'],
  ['thread.started', 'thread/started'],
  ['thread.tokenUsage/updated', 'thread/tokenUsage/updated'],
  ['turn.start', 'turn/start'],
  ['turn.steer', 'turn/steer'],
  ['turn.interrupt', 'turn/interrupt'],
  ['turn.started', 'turn/started'],
  ['turn.completed', 'turn/completed'],
  ['item.started', 'item/started'],
  ['item.completed', 'item/completed'],
  ['item.agentMessage.delta', 'item/agentMessage/delta'],
  ['item.commandExecution.outputDelta', 'item/commandExecution/outputDelta'],
  ['item.tool.call', 'item/tool/call'],
  ['item.tool.requestUserInput', 'item/tool/requestUserInput'],
  [
    'item.commandExecution.requestApproval',
    'item/commandExecution/requestApproval',
  ],
  ['item.fileChange.requestApproval', 'item/fileChange/requestApproval'],
  ['serverRequest.resolved', 'serverRequest/resolved'],
  ['account.rateLimits/updated', 'account/rateLimits/updated'],
  ['remoteControl.status.changed', 'remoteControl/status/changed'],
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const SYNTHETIC_COMMAND = 'echo lifecycle-replay';
const SYNTHETIC_OUTPUT = 'Synthetic lifecycle output';
const SYNTHETIC_AGENT_PATH = path.join(
  os.tmpdir(),
  'canopy-lifecycle-replay',
  'agent',
);

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value) {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isRequestUserInputResult(value) {
  const answers = readRecord(value, 'answers');
  return (
    answers !== undefined &&
    Object.keys(answers).length > 0 &&
    Object.values(answers).every(
      (answer) =>
        Array.isArray(answer?.answers) &&
        answer.answers.every((value) => typeof value === 'string'),
    )
  );
}

/** Read opt-in, content-free overrides for replay scenarios. */
export function readCodexReplayScenarioOptions(env = process.env) {
  const raw = env.CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS;
  if (raw === undefined) return {};

  let options;
  try {
    options = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS must contain valid JSON',
      { cause: error },
    );
  }
  if (!isRecord(options)) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS must be a JSON object',
    );
  }

  if (
    options.syntheticProcessId !== undefined &&
    (typeof options.syntheticProcessId !== 'string' ||
      options.syntheticProcessId.length === 0)
  ) {
    throw new TypeError('syntheticProcessId must be a non-empty string');
  }
  if (
    options.threadId !== undefined &&
    (typeof options.threadId !== 'string' || options.threadId.length === 0)
  ) {
    throw new TypeError('threadId must be a non-empty string');
  }
  if (
    options.requestUserInput !== undefined &&
    typeof options.requestUserInput !== 'boolean'
  ) {
    throw new TypeError('requestUserInput must be a boolean');
  }
  if (
    options.providerResolvesRequest !== undefined &&
    typeof options.providerResolvesRequest !== 'boolean'
  ) {
    throw new TypeError('providerResolvesRequest must be a boolean');
  }
  if (options.listPages !== undefined) {
    if (!Array.isArray(options.listPages)) {
      throw new TypeError('listPages must be an array of list pages');
    }
    for (const [index, page] of options.listPages.entries()) {
      if (
        !isRecord(page) ||
        (page.cursor !== null && typeof page.cursor !== 'string') ||
        !Array.isArray(page.data) ||
        (page.nextCursor !== null && typeof page.nextCursor !== 'string')
      ) {
        throw new TypeError(
          `listPages[${index}] must contain cursor, data, and nextCursor`,
        );
      }
    }
  }
  if (
    options.listFailure !== undefined &&
    (!isRecord(options.listFailure) ||
      !Number.isFinite(options.listFailure.code) ||
      typeof options.listFailure.message !== 'string')
  ) {
    throw new TypeError('listFailure must contain a numeric code and message');
  }

  return {
    ...(options.syntheticProcessId === undefined
      ? {}
      : { syntheticProcessId: options.syntheticProcessId }),
    ...(options.listPages === undefined
      ? {}
      : {
          listPages: options.listPages.map((page) => ({
            cursor: page.cursor,
            data: structuredClone(page.data),
            nextCursor: page.nextCursor,
          })),
        }),
    ...(options.listFailure === undefined
      ? {}
      : { listFailure: { ...options.listFailure } }),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.requestUserInput === true ? { requestUserInput: true } : {}),
    ...(options.providerResolvesRequest === true
      ? { providerResolvesRequest: true }
      : {}),
  };
}

function withProviderResolvedApprovalScenario(fixture) {
  const approvalControlIndex = fixture.steps.findIndex(
    (step) => step.kind === 'control' && step.action === 'approve',
  );
  if (approvalControlIndex < 0) {
    throw new Error('Provider-resolved approval scenario requires an approval');
  }
  const responseIndex = fixture.steps.findIndex(
    (step, index) =>
      index > approvalControlIndex &&
      step.kind === 'frame' &&
      step.type === 'response:item/commandExecution/requestApproval',
  );
  if (responseIndex < 0) {
    throw new Error('Provider-resolved approval scenario requires a response');
  }
  fixture.steps.splice(approvalControlIndex, 1, {
    kind: 'control',
    action: 'release',
    barrier: 'provider-resolution',
  });
  fixture.steps.splice(responseIndex, 1);
  return fixture;
}

function withRequestUserInputScenario(fixture, providerResolvesRequest) {
  const questionSteps = [
    {
      kind: 'frame',
      lane: 'root',
      type: 'request:item/tool/requestUserInput',
      ids: { thread: 'h1', turn: 't1', item: 'i4', request: 'r5' },
      template: 'codex.request',
    },
    ...(providerResolvesRequest
      ? [
          {
            kind: 'control',
            action: 'release',
            barrier: 'provider-resolution',
          },
        ]
      : [
          { kind: 'control', action: 'answer-user-input' },
          {
            kind: 'frame',
            lane: 'root',
            type: 'response:item/tool/requestUserInput',
            ids: { request: 'r5' },
            fields: { serverRequestResolution: 'result' },
            template: 'codex.response',
          },
        ]),
    {
      kind: 'frame',
      lane: 'root',
      type: 'notification:serverRequest/resolved',
      ids: { thread: 'h1', request: 'r5' },
      fields: { serverRequestResolution: 'resolved' },
      template: 'codex.notification',
    },
  ];
  const terminalIndex = fixture.steps.findIndex(
    (step) =>
      step.kind === 'frame' &&
      step.type === 'notification:thread/status/changed' &&
      step.fields?.threadStatus === 'idle',
  );
  if (terminalIndex < 0) {
    throw new Error(
      'Codex request_user_input scenario requires an idle terminal',
    );
  }
  fixture.steps.splice(terminalIndex, 0, ...questionSteps);
  return fixture;
}

function listRequestThreadId(method, params, context, rootThreadId) {
  if (method === BACKGROUND_TERMINALS_LIST_METHOD) return params.threadId;
  return (
    params.parentThreadId ??
    params.ancestorThreadId ??
    context.threadId ??
    rootThreadId
  );
}

function listOverrideResult(scenarioOptions, params) {
  if (!scenarioOptions.listPages) return undefined;
  const cursor = params.cursor ?? null;
  const page = scenarioOptions.listPages.find(
    (candidate) => candidate.cursor === cursor,
  );
  return page
    ? {
        data: structuredClone(page.data),
        nextCursor: page.nextCursor,
      }
    : { data: [], nextCursor: null };
}

function paginateList(data, params) {
  const cursor = params.cursor ?? null;
  const match =
    typeof cursor === 'string' ? /^offset:(\d+)$/.exec(cursor) : null;
  const offset = match ? Number(match[1]) : 0;
  const requestedLimit = params.limit;
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : Math.max(1, data.length);
  const page = data.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    data: page,
    nextCursor: nextOffset < data.length ? `offset:${nextOffset}` : null,
  };
}

function idKey(value) {
  if (!isJsonRpcId(value))
    throw new TypeError('JSON-RPC id must be a string or number');
  return `${typeof value}:${String(value)}`;
}

function readRecord(value, key) {
  const result = value?.[key];
  return isRecord(result) ? result : undefined;
}

function readId(record, ...keys) {
  for (const key of keys) {
    if (isJsonRpcId(record?.[key])) return record[key];
  }
  return undefined;
}

function readString(record, key) {
  return typeof record?.[key] === 'string' ? record[key] : undefined;
}

function collectCodexReplayIds(envelope) {
  const params = readRecord(envelope, 'params') ?? {};
  const result = readRecord(envelope, 'result') ?? {};
  const item = readRecord(params, 'item') ?? {};
  const resultItem = readRecord(result, 'item') ?? {};
  const paramThread = readRecord(params, 'thread') ?? {};
  const resultThread = readRecord(result, 'thread') ?? {};
  const paramTurn = readRecord(params, 'turn') ?? {};
  const resultTurn = readRecord(result, 'turn') ?? {};
  const ids = {};
  const thread =
    readId(params, 'threadId', 'thread_id') ??
    readId(paramThread, 'id') ??
    readId(result, 'threadId', 'thread_id') ??
    readId(resultThread, 'id');
  const turn =
    readId(params, 'turnId', 'turn_id') ??
    readId(paramTurn, 'id') ??
    readId(result, 'turnId', 'turn_id') ??
    readId(resultTurn, 'id');
  const itemId =
    readId(item, 'id') ??
    readId(params, 'itemId') ??
    readId(resultItem, 'id') ??
    readId(result, 'itemId');
  const request =
    readId(params, 'requestId', 'request_id') ??
    (isJsonRpcId(envelope?.id) ? envelope.id : undefined);
  const call =
    readId(params, 'callId', 'call_id') ??
    readId(item, 'callId') ??
    readId(result, 'callId', 'call_id');
  const task =
    readId(params, 'taskId', 'task_id') ?? readId(result, 'taskId', 'task_id');
  const toolUse =
    readId(params, 'toolUseId', 'tool_use_id') ??
    readId(item, 'toolUseId') ??
    readId(result, 'toolUseId', 'tool_use_id');
  const message =
    readId(params, 'messageId', 'message_id') ??
    (item.type === 'agentMessage' ? itemId : undefined);
  if (thread !== undefined) ids.thread = thread;
  if (turn !== undefined) ids.turn = turn;
  if (itemId !== undefined) ids.item = itemId;
  if (request !== undefined) ids.request = request;
  if (call !== undefined) ids.call = call;
  if (task !== undefined) ids.task = task;
  if (toolUse !== undefined) ids.toolUse = toolUse;
  if (message !== undefined) ids.message = message;
  return ids;
}

function methodFromType(type) {
  const match = /^(response|notification|request):(.+)$/.exec(type);
  if (!match)
    throw new Error(`Unsupported Codex replay frame type ${String(type)}`);
  const method = match[2];
  if (!SUPPORTED_METHODS.has(method)) {
    throw new Error(`Unsupported Codex replay method ${method}`);
  }
  const kind = match[1];
  const clientResponse =
    BOOTSTRAP_METHODS.has(method) ||
    ['turn/start', 'turn/steer', 'turn/interrupt'].includes(method);
  if (
    (kind === 'request' && !SERVER_REQUEST_METHODS.has(method)) ||
    (kind === 'response' &&
      !clientResponse &&
      !SERVER_REQUEST_RESPONSE_METHODS.has(method)) ||
    (kind === 'notification' &&
      (clientResponse || SERVER_REQUEST_METHODS.has(method)))
  ) {
    throw new Error(`Unsupported Codex ${kind} direction for ${method}`);
  }
  return { kind, method };
}

/** Resolve one of the finite Codex lifecycle templates to a JSON-RPC method. */
export function resolveCodexReplayTemplate(frame) {
  if (!isRecord(frame) || typeof frame.template !== 'string') {
    throw new TypeError('Codex replay frame requires a template');
  }
  const type = methodFromType(frame.type);
  if (frame.template === `codex.${type.kind}`) return type;
  if (frame.template.startsWith('codex.item.')) {
    const [, , itemType, status] = frame.template.split('.');
    if (!STATUS_ITEM_TYPES.has(itemType) || !status) {
      throw new Error(`Unsupported Codex item template ${frame.template}`);
    }
    const shape = frame.shape ?? [];
    if (shape[0] !== itemType || shape[1] !== status) {
      throw new Error(`Codex item template does not match ${frame.type}`);
    }
    if (!ITEM_STATUSES.has(status)) {
      throw new Error(`Unsupported Codex item status ${String(status)}`);
    }
    return type;
  }
  const suffix = frame.template.replace(/^codex\./, '');
  const mapped = TEMPLATE_METHODS.get(suffix) ?? suffix.replaceAll('.', '/');
  if (
    (frame.template.startsWith('codex.notification.') &&
      type.kind === 'notification') ||
    (frame.template.startsWith('codex.response.') &&
      type.kind === 'response') ||
    (frame.template.startsWith('codex.request.') && type.kind === 'request')
  ) {
    if (mapped !== type.method) {
      throw new Error(
        `Codex template ${frame.template} does not match ${frame.type}`,
      );
    }
    return type;
  }
  throw new Error(`Unsupported Codex replay template ${frame.template}`);
}

function putNested(target, dottedPath, value) {
  const segments = dottedPath.split('.').filter(Boolean);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment];
  }
  const leaf = segments.at(-1);
  if (leaf) current[leaf] = value;
}

function applyFields(target, fields = {}, defaultTarget) {
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'subagentKind') continue;
    if (key === 'segment') continue;
    if (key === 'turnStatus') {
      if (!TURN_STATUSES.has(value)) {
        throw new Error(`Unsupported Codex turn status ${String(value)}`);
      }
      putNested(target, 'turn.status', value);
      continue;
    }
    if (key === 'threadStatus') {
      if (!THREAD_STATUSES.has(value)) {
        throw new Error(`Unsupported Codex thread status ${String(value)}`);
      }
      const base = isRecord(target.thread)
        ? 'thread.status.type'
        : 'status.type';
      putNested(target, base, value);
      continue;
    }
    if (key === 'activeFlagsSet') {
      const base = isRecord(target.thread)
        ? 'thread.status.activeFlags'
        : 'status.activeFlags';
      putNested(target, base, value);
      continue;
    }
    if (key === 'terminalReason' && defaultTarget) {
      putNested(target, `${defaultTarget}.terminalReason`, value);
      continue;
    }
    const fieldPath =
      key.startsWith('params.') || key.startsWith('result.')
        ? key.slice(key.indexOf('.') + 1)
        : key;
    const normalized = fieldPath.replace(
      /(^|\.)turnStatus(?=\.|$)/g,
      '$1status',
    );
    putNested(
      target,
      normalized.includes('.') || !defaultTarget
        ? normalized
        : `${defaultTarget}.${normalized}`,
      value,
    );
  }
}

function syntheticThread(threadId, rootThreadId, cwd) {
  const child = rootThreadId !== undefined && rootThreadId !== threadId;
  return {
    thread: {
      id: threadId,
      preview: '',
      ephemeral: false,
      modelProvider: 'openai',
      model: 'gpt-6-sol',
      reasoningEffort: 'high',
      createdAt: 1,
      updatedAt: 1,
      status: { type: 'idle' },
      path: null,
      cwd,
      cliVersion: 'lifecycle-replay',
      source: child
        ? {
            subagent: {
              thread_spawn: {
                parent_thread_id: rootThreadId,
                depth: 1,
                agent_path: null,
                agent_nickname: 'Synthetic agent',
                agent_role: 'test worker',
              },
            },
          }
        : 'vscode',
      parentThreadId: child ? rootThreadId : null,
      agentNickname: child ? 'Synthetic agent' : null,
      agentRole: child ? 'test worker' : null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: 'gpt-6-sol',
    modelProvider: 'openai',
    serviceTier: null,
  };
}

function resolveCwd(candidate) {
  if (typeof candidate === 'string' && path.isAbsolute(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Fall through to the known-existing temporary directory.
    }
  }
  return os.tmpdir();
}

function materializeParams(method, frame, ids, context) {
  const params = {};
  if (ids.thread !== undefined) params.threadId = ids.thread;
  if (ids.turn !== undefined) params.turnId = ids.turn;
  if (ids.call !== undefined) params.callId = ids.call;
  if (ids.task !== undefined) params.taskId = ids.task;
  if (ids.toolUse !== undefined) params.toolUseId = ids.toolUse;
  if (method === 'serverRequest/resolved') {
    if (!isJsonRpcId(ids.request)) {
      throw new Error(
        'Codex serverRequest/resolved requires the exact live request id',
      );
    }
    params.requestId = ids.request;
  }

  if (method === 'thread/started') {
    const threadId =
      ids.thread ?? context.rootThreadId ?? 'codex-lifecycle-thread-root';
    const isRoot =
      context.rootThreadId === undefined || threadId === context.rootThreadId;
    params.thread =
      isRoot && context.threadResult?.thread
        ? { ...context.threadResult.thread, id: threadId }
        : syntheticThread(
            threadId,
            context.rootThreadId,
            resolveCwd(context.cwd),
          ).thread;
  } else if (method === 'turn/started' || method === 'turn/completed') {
    params.turn = {
      id: ids.turn ?? '',
      items: [],
      status: method === 'turn/completed' ? 'completed' : 'inProgress',
      error: null,
    };
  } else if (method === 'item/agentMessage/delta') {
    params.itemId = ids.message ?? ids.item ?? '';
    params.delta = SYNTHETIC_OUTPUT;
  } else if (method === 'item/commandExecution/outputDelta') {
    params.itemId = ids.item ?? '';
    params.delta = SYNTHETIC_OUTPUT;
  } else if (method === 'item/started' || method === 'item/completed') {
    if (
      !Array.isArray(frame.shape) ||
      frame.shape.length < 1 ||
      frame.shape.length > 2
    ) {
      throw new Error(`Codex ${method} frame requires a finite item shape`);
    }
    const itemType = frame.shape[0];
    if (!ITEM_TYPES.has(itemType))
      throw new Error(`Unsupported Codex item type ${String(itemType)}`);
    const itemId = ids.item ?? ids.message ?? ids.call ?? ids.toolUse ?? '';
    if (!isJsonRpcId(itemId))
      throw new Error(`Codex ${method} frame requires a live item id`);
    const item = { type: itemType, id: itemId };
    if (STATUS_ITEM_TYPES.has(itemType)) {
      const status =
        frame.shape?.[1] ??
        (method === 'item/completed' ? 'completed' : 'inProgress');
      if (!ITEM_STATUSES.has(status)) {
        throw new Error(`Unsupported Codex item status ${String(status)}`);
      }
      item.status = status;
    } else if (frame.shape.length !== 1) {
      throw new Error(
        `Codex item type ${itemType} does not support a status shape`,
      );
    }
    if (itemType === 'agentMessage') {
      Object.assign(item, {
        text: SYNTHETIC_OUTPUT,
        phase: 'final_answer',
        memoryCitation: null,
        delivery: null,
        questions: null,
      });
    } else if (itemType === 'userMessage') {
      Object.assign(item, {
        clientId: null,
        content: [
          { type: 'text', text: 'Synthetic user input', text_elements: [] },
        ],
      });
    } else if (itemType === 'dynamicToolCall') {
      Object.assign(item, {
        namespace: null,
        tool: 'canopy_schedule_wakeup',
        arguments: { delaySeconds: 120 },
        contentItems: null,
        success:
          item.status === 'inProgress' ? null : item.status === 'completed',
      });
    } else if (itemType === 'collabAgentToolCall') {
      Object.assign(item, {
        tool: 'spawnAgent',
        receiverThreadIds: ids.task !== undefined ? [ids.task] : [],
        agentsStates: {},
      });
    } else if (itemType === 'subAgentActivity') {
      const kind =
        frame.fields?.subagentKind ??
        (method === 'item/completed' ? 'completed' : 'started');
      if (!SUBAGENT_KINDS.has(kind))
        throw new Error(`Unsupported subagent activity kind ${String(kind)}`);
      const fallbackAgentThreadId =
        context.syntheticAgentThreadId ??
        'codex-lifecycle-synthetic-agent-thread';
      const agentThreadId = ids.agentThread ?? fallbackAgentThreadId;
      if (
        !isJsonRpcId(agentThreadId) ||
        agentThreadId === context.rootThreadId
      ) {
        throw new Error(
          'Codex subAgentActivity requires a fresh non-root agentThreadId',
        );
      }
      Object.assign(item, {
        kind,
        agentThreadId,
        agentPath: SYNTHETIC_AGENT_PATH,
      });
    } else if (itemType === 'commandExecution') {
      const active = item.status === 'inProgress';
      Object.assign(item, {
        command: SYNTHETIC_COMMAND,
        cwd: resolveCwd(context.cwd),
        commandActions: [],
        processId: null,
        aggregatedOutput: active ? null : SYNTHETIC_OUTPUT,
        exitCode: active ? null : 0,
        durationMs: active ? null : 0,
      });
    }
    params.item = item;
  } else if (method === 'item/tool/call') {
    Object.assign(params, {
      tool: 'canopy_schedule_wakeup',
      arguments: { delaySeconds: 120 },
    });
  } else if (method === 'item/tool/requestUserInput') {
    if (!isJsonRpcId(ids.item))
      throw new Error('Codex request_user_input requires a live item id');
    Object.assign(params, {
      itemId: ids.item,
      questions: [
        {
          id: 'lifecycle-choice',
          header: 'Choice',
          question: 'Choose an option for the synthetic task.',
          isOther: false,
          isSecret: false,
          options: [
            { label: 'Continue', description: 'Continue the recorded task' },
            { label: 'Pause', description: 'Pause the recorded task' },
          ],
        },
      ],
      isBlocking: true,
      autoResolutionMs: null,
    });
  } else if (method === 'item/commandExecution/requestApproval') {
    if (!isJsonRpcId(ids.item))
      throw new Error('Codex command approval requires a live item id');
    Object.assign(params, {
      itemId: ids.item,
      command: SYNTHETIC_COMMAND,
      commandActions: [],
      cwd: resolveCwd(context.cwd),
      reason: 'Synthetic lifecycle approval',
    });
  } else if (method === 'item/fileChange/requestApproval') {
    if (!isJsonRpcId(ids.item))
      throw new Error('Codex file-change approval requires a live item id');
    Object.assign(params, {
      itemId: ids.item,
      grantRoot: resolveCwd(context.cwd),
      reason: 'Synthetic lifecycle approval',
    });
  } else if (method === 'remoteControl/status/changed') {
    Object.assign(params, {
      status: 'disabled',
      serverName: 'synthetic',
      installationId: 'synthetic-installation',
      environmentId: null,
    });
  } else if (method === 'thread/tokenUsage/updated') {
    const emptyUsage = {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    params.tokenUsage = {
      total: { ...emptyUsage },
      last: { ...emptyUsage },
      modelContextWindow: null,
    };
  } else if (method === 'account/rateLimits/updated') {
    params.rateLimits = {
      limitId: null,
      limitName: null,
      normalModelSlug: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: null,
      rateLimitReachedType: null,
    };
  } else if (method === 'error') {
    params.error = {
      code: 'synthetic_lifecycle_error',
      message: 'Synthetic lifecycle error',
    };
    params.willRetry = frame.fields?.willRetry ?? false;
  }

  if (method === 'thread/status/changed') {
    const flags = frame.fields?.activeFlagsSet;
    params.status = {
      type: frame.fields?.threadStatus ?? 'active',
      ...(Array.isArray(flags)
        ? { activeFlags: [...flags] }
        : flags === null
          ? { activeFlags: null }
          : {}),
    };
  }
  const fields =
    method === 'serverRequest/resolved' && isRecord(frame.fields)
      ? Object.fromEntries(
          Object.entries(frame.fields).filter(
            ([key]) => key !== 'serverRequestResolution',
          ),
        )
      : frame.fields;
  applyFields(params, fields);
  return params;
}

function materializeResult(method, frame, ids, context) {
  let result;
  let target;
  if (method === 'initialize') {
    result = {
      userAgent: 'codex-lifecycle-replay',
      codexHome: resolveCwd(context.codexHome),
    };
  } else if (
    ['thread/start', 'thread/resume', 'thread/read', 'thread/fork'].includes(
      method,
    )
  ) {
    const id =
      ids.thread ?? context.rootThreadId ?? 'codex-lifecycle-thread-root';
    result =
      context.threadResult ??
      syntheticThread(id, context.rootThreadId, resolveCwd(context.cwd));
    target = 'thread';
  } else if (method === 'turn/start') {
    result = {
      turn: {
        id: ids.turn ?? 'codex-lifecycle-turn-1',
        items: [],
        status: 'inProgress',
        error: null,
      },
    };
    target = 'turn';
  } else if (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/tool/requestUserInput'
  ) {
    return { consumesResponse: true };
  } else {
    result = {};
  }
  applyFields(result, frame.fields, target);
  return { result };
}

/**
 * Materialize a validated recorded frame using only its finite shape/fields
 * and caller-supplied live IDs. Useful for content-free dry-run coverage.
 */
export function materializeCodexFrame(frame, { ids = {}, context = {} } = {}) {
  const { kind, method } = resolveCodexReplayTemplate(frame);
  if (kind === 'response')
    return { kind, method, ...materializeResult(method, frame, ids, context) };
  const params = materializeParams(method, frame, ids, context);
  if (kind === 'notification') return { kind, method, params };
  if (kind === 'request') {
    if (!SERVER_REQUEST_METHODS.has(method))
      throw new Error(`Unsupported Codex server request ${method}`);
    return { kind, method, params };
  }
  throw new Error(`Unsupported Codex replay envelope kind ${kind}`);
}

/** Dry-run every frame in a fixture with deterministic live aliases. */
export function dryRunCodexFixture(fixture, { cwd = os.tmpdir() } = {}) {
  const aliases = new Map();
  let next = 0;
  let nextChild = 0;
  const legacyAgentThreads = new Map();
  const rootThreadId = 'codex-dry-run-root-thread';
  const outputs = [];
  const getId = (kind, alias) => {
    if (alias === undefined) return undefined;
    const key = `${kind}:${alias}`;
    if (!aliases.has(key)) {
      next += 1;
      aliases.set(
        key,
        kind === 'request' ? next : `codex-dry-run-${kind}-${next}`,
      );
    }
    return aliases.get(key);
  };
  const allSteps = [];
  const collect = (steps) => {
    for (const step of steps) {
      if (step.kind === 'group') step.lanes.forEach(collect);
      else allSteps.push(step);
    }
  };
  collect(fixture.steps);
  const threadAlias = allSteps.find(
    (step) => step.kind === 'frame' && step.type === 'response:thread/start',
  )?.ids?.thread;
  if (threadAlias) aliases.set(`thread:${threadAlias}`, rootThreadId);
  for (const { step, index } of scheduleSteps(fixture)) {
    if (step.kind !== 'frame') continue;
    const ids = {};
    for (const kind of ID_KINDS) {
      if (step.ids?.[kind] !== undefined)
        ids[kind] = getId(kind, step.ids[kind]);
    }
    if (step.shape?.[0] === 'subAgentActivity') {
      let childId;
      if (step.ids?.agentThread !== undefined) {
        childId = getId('thread', step.ids.agentThread);
      } else {
        const legacyKey =
          step.ids?.item === undefined
            ? `${step.lane}:frame:${index}`
            : `${step.lane}:item:${idKey(step.ids.item)}`;
        childId = legacyAgentThreads.get(legacyKey);
        if (childId === undefined) {
          childId = `codex-dry-run-child-thread-${++nextChild}`;
          legacyAgentThreads.set(legacyKey, childId);
        }
      }
      if (childId === rootThreadId)
        throw new Error('Dry-run subagent thread aliases the root');
      ids.agentThread = childId;
    }
    const value = materializeCodexFrame(step, {
      ids,
      context: { rootThreadId, cwd },
    });
    outputs.push({ index, frame: step, value });
  }
  return outputs;
}

function timeoutPromise(ms, description) {
  return new Promise((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out after ${ms}ms waiting for ${description}`)),
      ms,
    );
    timer.unref?.();
  });
}

function makeQueue(timeoutMs, label) {
  const values = [];
  const waiters = [];
  return {
    push(value) {
      const waiterIndex = waiters.findIndex((candidate) =>
        candidate.predicate(value),
      );
      const waiter =
        waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : undefined;
      if (waiter) waiter.resolve(value);
      else values.push(value);
    },
    take(predicate = () => true) {
      const index = values.findIndex(predicate);
      if (index >= 0) return Promise.resolve(values.splice(index, 1)[0]);
      return Promise.race([
        new Promise((resolve, reject) =>
          waiters.push({ predicate, resolve, reject }),
        ),
        timeoutPromise(timeoutMs, label),
      ]);
    },
    get values() {
      return values;
    },
    close(error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    },
  };
}

function isSummaryContext(context) {
  return (
    context?.summary === true ||
    context?.isSummary === true ||
    context?.purpose === 'summary' ||
    context?.kind === 'summary'
  );
}

/** Create a Codex replay controller for a fake JSON-RPC stdio server. */
export function createCodexReplay({
  env = process.env,
  send,
  onError = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = readReplayEnv(env);
  if (!config) {
    return {
      enabled: false,
      recordBootstrap: () => false,
      handleRequest: () => false,
      handleResponse: () => false,
      waitForCompletion: async () => undefined,
      close: () => {},
    };
  }
  if (typeof send !== 'function')
    throw new TypeError('Codex replay requires a send callback');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    throw new TypeError('Codex replay timeout must be a non-negative integer');
  const fixture = loadReplayFixture(config.fixturePath);
  if (fixture.provider !== 'codex')
    throw new Error('Codex replay requires a Codex fixture');
  const scenarioOptions = readCodexReplayScenarioOptions(env);
  if (scenarioOptions.requestUserInput) {
    withRequestUserInputScenario(
      fixture,
      scenarioOptions.providerResolvesRequest,
    );
  } else if (scenarioOptions.providerResolvesRequest) {
    withProviderResolvedApprovalScenario(fixture);
  }
  const log = createReplayLog(config.logPath);
  const gates = createGates({
    dir: config.gatesDir,
    armed: config.armedGates,
    timeoutMs,
  });
  const aliases = new Map(ID_KINDS.map((kind) => [kind, new Map()]));
  const bootstrap = new Map();
  const bootstrapWaiters = [];
  const clientRequests = makeQueue(
    timeoutMs,
    'a matching Codex client request',
  );
  const pendingClientRequests = [];
  const approvalRequests = [];
  const approvalWaiters = [];
  const serverRequests = new Map();
  const approvalResponses = new Map();
  const requestUserInputResponses = new Map();
  const legacyAgentThreads = new Map();
  const knownThreads = new Map();
  const activeSubagentsByThread = new Map();
  const liveBackgroundTerminalsByThread = new Map();
  let rootThreadId;
  let rootThreadResult;
  let cwd = os.tmpdir();
  let requestCounter = 7000;
  let idCounter = 0;
  let replayPromise;
  let closedError;

  const bind = (kind, alias, live) => {
    if (alias === undefined || live === undefined) return;
    aliases.get(kind).set(alias, live);
  };
  const resolve = (kind, alias) =>
    alias === undefined ? undefined : aliases.get(kind).get(alias);
  const generatedId = (kind) => `codex-lifecycle-${kind}-${++idCounter}`;
  const getLiveIds = (frame, { bootstrapRecord, responseRecord } = {}) => {
    const expected = frame.ids ?? {};
    const ids = {};
    for (const kind of ID_KINDS) {
      const alias = expected[kind];
      if (alias === undefined) continue;
      let live = resolve(kind, alias);
      // A response frame's request alias must bind to the real client request,
      // not to a generated placeholder. It is assigned after matching below.
      if (
        kind === 'request' &&
        frame.type.startsWith('response:') &&
        !bootstrapRecord &&
        !responseRecord
      ) {
        continue;
      }
      if (kind === 'request' && responseRecord) live = responseRecord.id;
      if (
        kind === 'thread' &&
        live === undefined &&
        alias === expected.agentThread
      ) {
        live = generatedId('child-thread');
      }
      if (
        kind === 'thread' &&
        live === undefined &&
        alias === threadRootAlias()
      )
        live = rootThreadId;
      if (
        kind === 'thread' &&
        live === undefined &&
        rootThreadId &&
        rootThreadAlias() === undefined
      )
        live = rootThreadId;
      if (
        kind === 'thread' &&
        live === undefined &&
        frame.type === 'response:thread/start' &&
        bootstrapRecord
      ) {
        live = bootstrapRecord.threadId;
      }
      // A start that joins the active turn keeps that turn's live id.
      if (
        kind === 'turn' &&
        live === undefined &&
        frame.type === 'response:turn/start' &&
        responseRecord
      ) {
        live = isJsonRpcId(responseRecord.context.turnId)
          ? responseRecord.context.turnId
          : generatedId('turn');
      }
      if (
        kind === 'turn' &&
        live === undefined &&
        frame.type === 'response:turn/start' &&
        !responseRecord
      ) {
        continue;
      }
      if (kind === 'request' && live === undefined && bootstrapRecord)
        live = bootstrapRecord.id;
      if (kind === 'request' && live === undefined) live = requestCounter++;
      if (live === undefined) live = generatedId(kind);
      bind(kind, alias, live);
      ids[kind] = live;
    }
    if (frame.shape?.[0] === 'subAgentActivity') {
      let live;
      if (expected.agentThread !== undefined) {
        const alias = expected.agentThread;
        live = resolve('thread', alias);
        if (live === undefined) {
          live = generatedId('child-thread');
          bind('thread', alias, live);
        }
      } else {
        const legacyKey =
          expected.item === undefined
            ? `${frame.lane}:frame:${generatedId('activity')}`
            : `${frame.lane}:item:${idKey(expected.item)}`;
        live = legacyAgentThreads.get(legacyKey);
        if (live === undefined) {
          live = generatedId('child-thread');
          legacyAgentThreads.set(legacyKey, live);
        }
      }
      if (live === rootThreadId)
        throw new Error(
          'Codex subAgentActivity agentThreadId cannot be the root thread',
        );
      ids.agentThread = live;
    }
    if (bootstrapRecord && expected.thread !== undefined)
      bind('thread', expected.thread, bootstrapRecord.threadId);
    return ids;
  };
  const rootThreadAlias = () => {
    for (const [alias, live] of aliases.get('thread'))
      if (live === rootThreadId) return alias;
    return undefined;
  };
  const threadRootAlias = () => {
    const threadStart = fixture.steps.find(
      (step) => step.kind === 'frame' && step.type === 'response:thread/start',
    );
    return threadStart?.ids?.thread;
  };
  const bootstrapList = (method) => bootstrap.get(method) ?? [];

  function bootstrapThreadId(record) {
    const result = readRecord(record.response, 'result') ?? record.result;
    return (
      readId(readRecord(result, 'thread') ?? {}, 'id') ??
      readId(result, 'threadId', 'thread_id')
    );
  }

  function rememberThread(thread) {
    if (!isRecord(thread) || typeof thread.id !== 'string') return;
    knownThreads.set(thread.id, structuredClone(thread));
  }

  function getKnownThread(threadId) {
    let thread = knownThreads.get(threadId);
    if (thread) return thread;
    thread = syntheticThread(
      threadId,
      threadId === rootThreadId ? undefined : rootThreadId,
      resolveCwd(cwd),
    ).thread;
    rememberThread(thread);
    return knownThreads.get(threadId);
  }

  function isActiveSubagentThread(threadId) {
    for (const tasks of activeSubagentsByThread.values()) {
      for (const task of tasks.values()) {
        if (task.agentThreadId === threadId) return true;
      }
    }
    return false;
  }

  function listThreads(params) {
    let threads = Array.from(knownThreads.values(), (thread) => {
      const copy = structuredClone(thread);
      if (isActiveSubagentThread(copy.id)) copy.status = { type: 'active' };
      return copy;
    });
    if (params.parentThreadId) {
      threads = threads.filter(
        (thread) => thread.parentThreadId === params.parentThreadId,
      );
    }
    if (params.ancestorThreadId) {
      const ancestor = params.ancestorThreadId;
      const isDescendant = (thread) => {
        let parentId = thread.parentThreadId;
        const visited = new Set();
        while (parentId && !visited.has(parentId)) {
          if (parentId === ancestor) return true;
          visited.add(parentId);
          parentId = knownThreads.get(parentId)?.parentThreadId;
        }
        return false;
      };
      threads = threads.filter(isDescendant);
    }
    if (params.cwd !== undefined) {
      const cwdValues = Array.isArray(params.cwd) ? params.cwd : [params.cwd];
      threads = threads.filter((thread) => cwdValues.includes(thread.cwd));
    }
    return threads;
  }

  function listBackgroundTerminals(threadId) {
    return Array.from(
      liveBackgroundTerminalsByThread.get(threadId)?.values() ?? [],
      (terminal) => structuredClone(terminal),
    );
  }

  function updateLiveListState(method, params) {
    if (method === 'thread/started') {
      rememberThread(params.thread);
      return;
    }
    if (method === 'thread/status/changed') {
      if (typeof params.threadId !== 'string') return;
      getKnownThread(params.threadId).status = structuredClone(params.status);
      return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    const item = params.item;
    if (!isRecord(item)) return;

    if (item.type === 'subAgentActivity') {
      const parentThreadId = params.threadId;
      const agentThreadId = item.agentThreadId;
      if (typeof agentThreadId === 'string') {
        const child = getKnownThread(agentThreadId);
        if (parentThreadId && child.parentThreadId !== parentThreadId) {
          child.parentThreadId = parentThreadId;
        }
        if (!isRecord(child.source?.subagent?.thread_spawn)) {
          child.source = {
            subagent: {
              thread_spawn: {
                parent_thread_id: parentThreadId ?? rootThreadId ?? null,
                depth: 1,
                agent_path: item.agentPath ?? null,
                agent_nickname: child.agentNickname ?? 'Synthetic agent',
                agent_role: child.agentRole ?? 'test worker',
              },
            },
          };
        }
        if (item.kind === 'started' && method === 'item/started') {
          const tasks =
            activeSubagentsByThread.get(parentThreadId) ?? new Map();
          tasks.set(idKey(item.id), { agentThreadId });
          activeSubagentsByThread.set(parentThreadId, tasks);
        } else if (
          ['completed', 'interrupted'].includes(item.kind) &&
          method === 'item/completed'
        ) {
          const tasks = activeSubagentsByThread.get(parentThreadId);
          tasks?.delete(idKey(item.id));
          if (tasks?.size === 0) activeSubagentsByThread.delete(parentThreadId);
        }
      }
      return;
    }

    if (item.type !== 'commandExecution' || typeof params.threadId !== 'string')
      return;
    const commands =
      liveBackgroundTerminalsByThread.get(params.threadId) ?? new Map();
    const itemKey = idKey(item.id);
    if (
      method === 'item/started' &&
      item.status === 'inProgress' &&
      item.processId == null &&
      scenarioOptions.syntheticProcessId &&
      (scenarioOptions.threadId === undefined ||
        scenarioOptions.threadId === params.threadId)
    ) {
      // Opt-in only: the immutable recording still materializes null by
      // default. This live id belongs to the emitted frame, not the skeleton.
      item.processId = scenarioOptions.syntheticProcessId;
    }
    if (
      method === 'item/started' &&
      item.status === 'inProgress' &&
      typeof item.processId === 'string'
    ) {
      commands.set(itemKey, {
        itemId: String(item.id),
        processId: item.processId,
        command: item.command,
        cwd: item.cwd,
        osPid: null,
        cpuPercent: null,
        rssKb: null,
      });
      liveBackgroundTerminalsByThread.set(params.threadId, commands);
      return;
    }
    if (method === 'item/completed' || item.status !== 'inProgress') {
      commands.delete(itemKey);
      if (commands.size === 0) {
        liveBackgroundTerminalsByThread.delete(params.threadId);
      } else {
        liveBackgroundTerminalsByThread.set(params.threadId, commands);
      }
    }
  }

  function handleListRequest(message, context) {
    const method = readString(message, 'method');
    const params = readRecord(message, 'params') ?? {};
    const requestThreadId = listRequestThreadId(
      method,
      params,
      context,
      rootThreadId,
    );
    const inScope =
      scenarioOptions.threadId === undefined ||
      requestThreadId === scenarioOptions.threadId;
    if (inScope && scenarioOptions.listFailure) {
      void sendEnvelope({
        id: message.id,
        error: { ...scenarioOptions.listFailure },
      });
      return true;
    }

    let page;
    if (!inScope) {
      page = { data: [], nextCursor: null };
    } else {
      page = listOverrideResult(scenarioOptions, params);
      if (!page) {
        const data =
          method === THREAD_LIST_METHOD
            ? listThreads(params)
            : listBackgroundTerminals(params.threadId);
        page = paginateList(data, params);
      }
    }
    const result =
      method === THREAD_LIST_METHOD ? { ...page, backwardsCursor: null } : page;
    void sendEnvelope({ id: message.id, result });
    return true;
  }

  function notifyBootstrapWaiters() {
    for (let index = 0; index < bootstrapWaiters.length; ) {
      const waiter = bootstrapWaiters[index];
      const records = bootstrapList(waiter.method);
      const match = records.findIndex((record) => {
        if (
          waiter.method !== 'thread/start' &&
          waiter.method !== 'thread/resume'
        )
          return true;
        const requestedRoot = waiter.contextThreadId ?? rootThreadId;
        const resultThreadId = bootstrapThreadId(record);
        return requestedRoot === undefined || resultThreadId === requestedRoot;
      });
      if (match < 0) {
        index += 1;
        continue;
      }
      const record = records.splice(match, 1)[0];
      bootstrapWaiters.splice(index, 1);
      waiter.resolve(record);
    }
  }

  async function takeBootstrap(method, contextThreadId) {
    const records = bootstrapList(method);
    const requestedRoot = contextThreadId ?? rootThreadId;
    const match = records.findIndex((record) => {
      if (method !== 'thread/start' && method !== 'thread/resume') return true;
      const resultThreadId = bootstrapThreadId(record);
      return requestedRoot === undefined || resultThreadId === requestedRoot;
    });
    if (match >= 0) return records.splice(match, 1)[0];
    return Promise.race([
      new Promise((resolve, reject) =>
        bootstrapWaiters.push({ method, contextThreadId, resolve, reject }),
      ),
      timeoutPromise(timeoutMs, `the real ${method} bootstrap response`),
    ]);
  }

  function reportError(error) {
    try {
      onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      /* Keep the harness fail-closed. */
    }
  }

  function startReplay() {
    if (replayPromise) return replayPromise;
    replayPromise = runReplay({
      fixture,
      log,
      gates,
      delays: config.delays,
      adapter: { emitFrame, handleControl },
    });
    replayPromise.catch(reportError);
    return replayPromise;
  }

  function findClientRequest(method, frame) {
    const alias = frame.ids?.request;
    const expectedId = resolve('request', alias);
    return pendingClientRequests.find(
      (request) =>
        request.method === method &&
        request.controlMatched &&
        !request.responseSent &&
        (expectedId === undefined || request.id === expectedId),
    );
  }

  async function sendEnvelope(envelope) {
    await send(envelope);
  }

  async function emitFrame(frame) {
    const { kind, method } = resolveCodexReplayTemplate(frame);
    if (kind === 'response' && BOOTSTRAP_METHODS.has(method)) {
      const record = await takeBootstrap(method, rootThreadId);
      const actualIds = collectCodexReplayIds(
        record.response ?? { result: record.result, id: record.id },
      );
      const ids = getLiveIds(frame, {
        bootstrapRecord: { id: record.id, threadId: bootstrapThreadId(record) },
      });
      if (frame.ids?.request !== undefined)
        bind('request', frame.ids.request, record.id);
      if (frame.ids?.thread !== undefined && actualIds.thread !== undefined)
        bind('thread', frame.ids.thread, actualIds.thread);
      if (method === 'thread/start' || method === 'thread/resume') {
        const liveThread = bootstrapThreadId(record);
        if (
          liveThread !== undefined &&
          (rootThreadId === undefined || liveThread === rootThreadId)
        ) {
          rootThreadId = liveThread;
          rootThreadResult = record.response?.result ?? record.result;
        }
        if (ids.thread !== undefined && liveThread !== undefined)
          bind('thread', frame.ids.thread, liveThread);
      }
      return;
    }

    if (kind === 'response' && method === 'item/tool/requestUserInput') {
      const alias = frame.ids?.request;
      const id = resolve('request', alias);
      if (id === undefined)
        throw new Error(
          `request_user_input response frame ${frame.type} has no live request id`,
        );
      const response = requestUserInputResponses.get(idKey(id));
      if (!response)
        throw new Error(
          `Codex request_user_input response ${String(id)} was not observed`,
        );
      if (response.fixtureConsumed)
        throw new Error(
          `Codex request_user_input response ${String(id)} was already consumed`,
        );
      if (
        frame.fields?.serverRequestResolution !== 'result' ||
        response.error ||
        !isRequestUserInputResult(response.result)
      ) {
        throw new Error(
          `Codex request_user_input response ${String(id)} did not contain answers`,
        );
      }
      if (!response.controlMatched)
        throw new Error('Codex request_user_input response was not controlled');
      response.fixtureConsumed = true;
      requestUserInputResponses.delete(idKey(id));
      return;
    }

    if (kind === 'response' && APPROVAL_METHODS.has(method)) {
      const alias = frame.ids?.request;
      const id = resolve('request', alias);
      if (id === undefined)
        throw new Error(
          `Approval response frame ${frame.type} has no live request id`,
        );
      const record = approvalResponses.get(idKey(id));
      if (!record) {
        await Promise.race([
          new Promise((resolve, reject) =>
            approvalWaiters.push({ id, resolve, reject }),
          ),
          timeoutPromise(
            timeoutMs,
            `the exact Codex approval response ${String(id)}`,
          ),
        ]);
      }
      const response = approvalResponses.get(idKey(id));
      if (!response)
        throw new Error(
          `Codex approval response ${String(id)} was not observed`,
        );
      if (response.fixtureConsumed) {
        throw new Error(
          `Codex approval response ${String(id)} was already consumed`,
        );
      }
      const expected = frame.fields?.serverRequestResolution;
      if (
        expected === 'error'
          ? !response.error
          : expected === 'result'
            ? response.error ||
              !['accept', 'decline'].includes(response.decision)
            : expected === 'resolved'
      ) {
        throw new Error(`Codex approval response does not match ${expected}`);
      }
      if (
        response.controlDecision &&
        response.decision !== response.controlDecision
      ) {
        throw new Error(
          'Codex approval response did not match the recorded approve/deny control',
        );
      }
      response.fixtureConsumed = true;
      approvalResponses.delete(idKey(id));
      return;
    }

    if (kind === 'response') {
      if (!['turn/start', 'turn/steer', 'turn/interrupt'].includes(method)) {
        throw new Error(
          `Unsupported Codex client response frame ${frame.type}`,
        );
      }
      const request = findClientRequest(method, frame);
      if (!request || !request.controlMatched) {
        throw new Error(
          `No control-matched live Codex ${method} request for ${frame.type}`,
        );
      }
      const liveIds = getLiveIds(frame, { responseRecord: request });
      liveIds.request = request.id;
      if (frame.ids?.request !== undefined)
        bind('request', frame.ids.request, request.id);
      if (method === 'turn/start') {
        const turnAlias = frame.ids?.turn;
        const turnId =
          resolve('turn', turnAlias) ??
          (isJsonRpcId(request.context.turnId)
            ? request.context.turnId
            : generatedId('turn'));
        if (turnAlias !== undefined) bind('turn', turnAlias, turnId);
        liveIds.turn = turnId;
      }
      const context = {
        rootThreadId,
        cwd,
        threadResult: rootThreadResult,
        ...request.context,
      };
      const value = materializeCodexFrame(frame, { ids: liveIds, context });
      const envelope =
        frame.fields?.serverRequestResolution === 'error'
          ? {
              id: request.id,
              error: { code: -32603, message: 'Synthetic lifecycle error' },
            }
          : { id: request.id, result: value.result ?? {} };
      await sendEnvelope(envelope);
      request.responseSent = true;
      return;
    }

    const ids = getLiveIds(frame);
    const context = { rootThreadId, cwd, threadResult: rootThreadResult };
    const value = materializeCodexFrame(frame, { ids, context });
    if (kind === 'notification') {
      updateLiveListState(method, value.params);
      if (method === 'serverRequest/resolved') {
        const requestId = readId(value.params, 'requestId', 'request_id');
        if (requestId !== undefined) serverRequests.delete(idKey(requestId));
      }
      await sendEnvelope({ method, params: value.params });
      return;
    }
    if (kind === 'request') {
      const id = ids.request ?? requestCounter++;
      if (frame.ids?.request !== undefined)
        bind('request', frame.ids.request, id);
      const envelope = { id, method, params: value.params };
      const pending = { id, method, frame, decision: undefined };
      serverRequests.set(idKey(id), pending);
      if (
        APPROVAL_METHODS.has(method) ||
        method === 'item/tool/requestUserInput'
      ) {
        approvalRequests.push(pending);
        const waiterIndex = approvalWaiters.findIndex(
          (waiter) => waiter.request === true,
        );
        if (waiterIndex >= 0)
          approvalWaiters.splice(waiterIndex, 1)[0].resolve(pending);
      }
      await sendEnvelope(envelope);
      return;
    }
    throw new Error(`Unsupported Codex replay frame kind ${kind}`);
  }

  async function handleControl(control) {
    if (control.action === 'release') return;
    if (
      control.action === 'send' ||
      control.action === 'start-turn' ||
      control.action === 'steer' ||
      control.action === 'interrupt'
    ) {
      const method =
        control.action === 'send' || control.action === 'start-turn'
          ? 'turn/start'
          : `turn/${control.action}`;
      const request = await clientRequests.take(
        (candidate) => candidate.method === method && !candidate.controlMatched,
      );
      request.controlMatched = true;
      if (control.ids?.thread !== undefined)
        bind(
          'thread',
          control.ids.thread,
          request.context.threadId ?? rootThreadId,
        );
      if (
        control.ids?.turn !== undefined &&
        request.context.turnId !== undefined
      )
        bind('turn', control.ids.turn, request.context.turnId);
      if (control.ids?.request !== undefined)
        bind('request', control.ids.request, request.id);
      return;
    }
    if (control.action === 'approve' || control.action === 'deny') {
      const request = await waitForApprovalRequest();
      const expectedDecision =
        control.action === 'approve' ? 'accept' : 'decline';
      request.controlDecision = expectedDecision;
      const response = await waitForApprovalResponse(request.id);
      if (response.error || response.decision !== expectedDecision) {
        throw new Error(
          `Codex approval ${control.action} did not receive exact ${expectedDecision} response for ${String(request.id)}`,
        );
      }
      return;
    }
    if (control.action === 'answer-user-input') {
      const request = await waitForApprovalRequest();
      if (request.method !== 'item/tool/requestUserInput')
        throw new Error('Expected a Codex request_user_input request');
      request.controlDecision = 'answer';
      const response = await waitForRequestUserInputResponse(request.id);
      if (response.error || !isRequestUserInputResult(response.result)) {
        throw new Error(
          `Codex request_user_input ${String(request.id)} did not receive answers`,
        );
      }
      return;
    }
    throw new Error(
      `Unsupported Codex replay control ${String(control.action)}`,
    );
  }

  async function waitForRequestUserInputResponse(id) {
    const current = requestUserInputResponses.get(idKey(id));
    if (current) return current;
    return Promise.race([
      new Promise((resolve, reject) =>
        approvalWaiters.push({ id, resolve, reject }),
      ),
      timeoutPromise(
        timeoutMs,
        `the exact Codex request_user_input response ${String(id)}`,
      ),
    ]);
  }

  async function waitForApprovalRequest() {
    const pending = approvalRequests.find(
      (request) => !request.controlDecision,
    );
    if (pending) return pending;
    return Promise.race([
      new Promise((resolve, reject) =>
        approvalWaiters.push({ request: true, resolve, reject }),
      ),
      timeoutPromise(timeoutMs, 'a Codex approval request'),
    ]);
  }

  async function waitForApprovalResponse(id) {
    const current = approvalResponses.get(idKey(id));
    if (current) return current;
    return Promise.race([
      new Promise((resolve, reject) =>
        approvalWaiters.push({ id, resolve, reject }),
      ),
      timeoutPromise(
        timeoutMs,
        `the exact Codex approval response ${String(id)}`,
      ),
    ]);
  }

  const controller = {
    enabled: true,
    fixture,
    recordBootstrap(request, response, context = {}) {
      if (isSummaryContext(context)) return false;
      const method = readString(request, 'method');
      if (!BOOTSTRAP_METHODS.has(method)) return false;
      if (!isJsonRpcId(request.id))
        throw new Error(
          `Codex ${method} bootstrap request requires a JSON-RPC id`,
        );
      let envelope;
      if (
        isRecord(response) &&
        (Object.hasOwn(response, 'result') || Object.hasOwn(response, 'error'))
      ) {
        envelope = response;
        if (isJsonRpcId(envelope.id) && envelope.id !== request.id)
          throw new Error(
            `Codex ${method} bootstrap response id did not match its request`,
          );
      } else {
        envelope = { id: request.id, result: response };
      }
      const record = {
        id: request.id,
        request,
        response: envelope,
        result: envelope.result,
        threadId: bootstrapThreadId({ response: envelope }),
      };
      rememberThread(readRecord(envelope.result, 'thread'));
      if (
        ['thread/start', 'thread/resume'].includes(method) &&
        rootThreadId === undefined &&
        record.threadId !== undefined
      ) {
        rootThreadId = record.threadId;
        rootThreadResult = envelope.result;
      }
      const list = bootstrap.get(method) ?? [];
      list.push(record);
      bootstrap.set(method, list);
      notifyBootstrapWaiters();
      return true;
    },
    handleRequest(message, context = {}) {
      if (closedError) throw closedError;
      const method = readString(message, 'method');
      if (LIST_METHODS.has(method) && !isSummaryContext(context)) {
        if (!isJsonRpcId(message.id)) return false;
        return handleListRequest(message, context);
      }
      if (
        !['turn/start', 'turn/steer', 'turn/interrupt'].includes(method) ||
        isSummaryContext(context)
      )
        return false;
      if (!isJsonRpcId(message.id)) return false;
      const hasControl = scheduleSteps(fixture).some(
        ({ step }) =>
          step.kind === 'control' &&
          ((method === 'turn/start' &&
            ['send', 'start-turn'].includes(step.action)) ||
            step.action === method.slice('turn/'.length)),
      );
      if (!hasControl) return false;
      const params = readRecord(message, 'params') ?? {};
      const threadId =
        context.threadId ??
        readId(params, 'threadId', 'thread_id') ??
        rootThreadId;
      if (
        method === 'turn/start' &&
        rootThreadId === undefined &&
        threadId !== undefined
      )
        rootThreadId = threadId;
      if (context.cwd !== undefined) cwd = resolveCwd(context.cwd);
      const record = {
        id: message.id,
        method,
        params,
        context: {
          ...context,
          threadId,
          turnId: context.turnId ?? readId(params, 'turnId', 'turn_id'),
        },
        controlMatched: false,
        responseSent: false,
      };
      clientRequests.push(record);
      pendingClientRequests.push(record);
      startReplay();
      return true;
    },
    handleResponse(message) {
      if (closedError) throw closedError;
      if (!isRecord(message) || !isJsonRpcId(message.id)) return false;
      const request = serverRequests.get(idKey(message.id));
      if (!request) return false;
      const result = readRecord(message, 'result');
      const error = readRecord(message, 'error');
      if (request.method === 'item/tool/requestUserInput') {
        if (!error && !isRequestUserInputResult(result)) {
          throw new Error(
            `Codex request_user_input response ${String(message.id)} must contain answers`,
          );
        }
        const observed = {
          id: message.id,
          result,
          error: Boolean(error),
          controlMatched: request.controlDecision === 'answer',
          fixtureConsumed: false,
        };
        requestUserInputResponses.set(idKey(message.id), observed);
        log.write({
          kind: 'request-user-input-response',
          type: error ? 'error' : 'answered',
          name: String(message.id),
        });
        serverRequests.delete(idKey(message.id));
        const matching = approvalWaiters.filter(
          (waiter) => waiter.id !== undefined && waiter.id === message.id,
        );
        for (const waiter of matching) {
          approvalWaiters.splice(approvalWaiters.indexOf(waiter), 1);
          waiter.resolve(observed);
        }
        return true;
      }
      if (!APPROVAL_METHODS.has(request.method)) return false;
      const decision =
        readString(result, 'decision') ?? readString(result, 'action');
      if (!error && decision !== 'accept' && decision !== 'decline') {
        throw new Error(
          `Codex approval response ${String(message.id)} must contain accept or decline`,
        );
      }
      const observed = {
        id: message.id,
        decision,
        error: Boolean(error),
        controlDecision: request.controlDecision,
        fixtureConsumed: false,
      };
      approvalResponses.set(idKey(message.id), observed);
      log.write({
        kind: 'approval-response',
        type: decision ?? 'error',
        name: String(message.id),
      });
      serverRequests.delete(idKey(message.id));
      const matching = approvalWaiters.filter(
        (waiter) => waiter.id !== undefined && waiter.id === message.id,
      );
      for (const waiter of matching) {
        approvalWaiters.splice(approvalWaiters.indexOf(waiter), 1);
        waiter.resolve(observed);
      }
      return true;
    },
    waitForCompletion() {
      return replayPromise ?? Promise.resolve(undefined);
    },
    close(error = new Error('Codex lifecycle replay closed')) {
      closedError = error;
      clientRequests.close(error);
      for (const waiter of bootstrapWaiters.splice(0)) waiter.reject(error);
      for (const waiter of approvalWaiters.splice(0)) waiter.reject(error);
    },
  };
  return controller;
}
