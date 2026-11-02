/**
 * Fail-closed, content-free Claude materialization for lifecycle fixtures.
 *
 * Fixture values are aliases and bounded observations, not provider payloads.
 * This adapter turns only the known Claude fixture shapes into SDK-shaped
 * messages; user-visible text and tool inputs are always synthetic. It never
 * executes the synthetic Bash command.
 */
import { randomUUID } from 'node:crypto';
import { scheduleSteps } from './lifecycle-replay.mjs';
import {
  CLAUDE_BLOCK_TYPES,
  CLAUDE_COMMAND_STATES,
  CLAUDE_ORIGIN_KINDS,
  CLAUDE_RESULT_SUBTYPES,
  CLAUDE_SESSION_STATES,
  CLAUDE_STOP_REASONS,
  CLAUDE_STREAM_DELTA_TYPES,
  CLAUDE_STREAM_EVENT_TYPES,
  CLAUDE_SYSTEM_SUBTYPES,
  CLAUDE_TASK_STATUSES,
  CLAUDE_TASK_TYPES,
  CLAUDE_TERMINAL_REASONS,
  CLAUDE_TOOL_RESULT_STATUSES,
  CODEX_ACTIVE_FLAGS,
  CODEX_SUBAGENT_ACTIVITY_KINDS,
  CODEX_THREAD_STATUSES,
  CODEX_TURN_STATUSES,
  ERROR_CLASSES,
  FIELD_KEYS,
  ID_KINDS,
  ID_PREFIX,
  TEMPLATE_REGISTRY,
  validateFixture,
} from '../../../../../scripts/harness-contract/lifecycle/schema.mjs';

export const REPLAY_TEXT = 'Claude lifecycle replay complete';
/** A composed fixture's Monitor call, named for the wake row's label. */
export const REPLAY_MONITOR_DESCRIPTION = 'Claude lifecycle replay monitor';
const MONITOR_TOOL_SEMANTICS = /^monitor-tool\/(u[1-9][0-9]*)$/;
/** The prompt a composed fixture's CronCreate call schedules. */
export const REPLAY_CRON_PROMPT = 'Claude lifecycle replay scheduled prompt';
const CRON_TOOL_SEMANTICS = /^cron-tool\/(u[1-9][0-9]*)$/;
export const REPLAY_TOOL_INPUT = Object.freeze({
  command: 'printf canopy-lifecycle-replay',
});
const REPLAY_TOOL_RESULT = 'Synthetic tool result';

const FRAME_KEYS = new Set([
  'kind',
  'lane',
  'type',
  'shape',
  'ids',
  'consumed',
  'fields',
  'template',
]);
const ID_KEY_SET = new Set(ID_KINDS);
const FIELD_KEY_SET = new Set(FIELD_KEYS);
const RESULT_SUBTYPES = new Set(CLAUDE_RESULT_SUBTYPES);
const TOOL_RESULT_STATUSES = new Set(CLAUDE_TOOL_RESULT_STATUSES);
const STREAM_EVENT_SET = new Set(CLAUDE_STREAM_EVENT_TYPES);
const STREAM_DELTA_SET = new Set(CLAUDE_STREAM_DELTA_TYPES);
const CLAUDE_TEMPLATES = new Set(
  Object.entries(TEMPLATE_REGISTRY)
    .filter(([, definition]) => definition.provider === 'claude')
    .map(([name]) => name),
);

const FIELD_ENUMS = new Map([
  ['originKind', new Set(CLAUDE_ORIGIN_KINDS)],
  ['terminalReason', new Set(CLAUDE_TERMINAL_REASONS)],
  ['stopReason', new Set(CLAUDE_STOP_REASONS)],
  [
    'resultSubtype',
    new Set([...CLAUDE_RESULT_SUBTYPES, ...CLAUDE_TOOL_RESULT_STATUSES]),
  ],
  ['sessionState', new Set(CLAUDE_SESSION_STATES)],
  ['commandState', new Set(CLAUDE_COMMAND_STATES)],
  ['taskStatus', new Set(CLAUDE_TASK_STATUSES)],
  ['threadStatus', new Set(CODEX_THREAD_STATUSES)],
  ['subagentKind', new Set(CODEX_SUBAGENT_ACTIVITY_KINDS)],
  ['activeFlagsSet', new Set(CODEX_ACTIVE_FLAGS)],
  ['turnStatus', new Set(CODEX_TURN_STATUSES)],
  ['serverRequestResolution', new Set(['error', 'resolved', 'result'])],
  ['errorClass', new Set(ERROR_CLASSES)],
  ['taskType', new Set(CLAUDE_TASK_TYPES)],
]);

const BOOLEAN_FIELDS = new Set([
  'isError',
  'isBackgrounded',
  'ambient',
  'willRetry',
]);
const SAFE_SYMBOL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_MESSAGE_ALIAS = /^m[1-9][0-9]*$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
}

function assertEnum(value, choices, label) {
  if (typeof value !== 'string' || !choices.includes(value))
    throw new TypeError(`Unsupported Claude replay ${label}`);
  return value;
}

function assertAlias(kind, alias) {
  if (!ID_KEY_SET.has(kind) || typeof alias !== 'string')
    throw new TypeError('Unsupported Claude replay identifier');
  const prefix = ID_PREFIX[kind];
  if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(alias))
    throw new TypeError('Invalid Claude replay identifier alias');
  return alias;
}

function validateFields(fields, type) {
  if (fields === undefined) return {};
  assertRecord(fields, 'Claude replay fields');
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_KEY_SET.has(key))
      throw new TypeError('Unsupported Claude replay field');
    if (value === null) continue;
    const allowedValues = FIELD_ENUMS.get(key);
    if (allowedValues) {
      const values = Array.isArray(value) ? value : [value];
      if (
        values.some(
          (item) => typeof item !== 'string' || !allowedValues.has(item),
        )
      )
        throw new TypeError(`Unsupported Claude replay ${key}`);
      continue;
    }
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== 'boolean')
        throw new TypeError(`Invalid Claude replay ${key}`);
      continue;
    }
    if (key === 'resultIndex') {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError('Invalid Claude replay resultIndex');
      continue;
    }
    if (key === 'workflowName') {
      if (typeof value !== 'string' || !/^workflow[1-9][0-9]*$/.test(value))
        throw new TypeError('Invalid Claude replay workflowName');
      continue;
    }
    if (key === 'workflowPhase') {
      if (typeof value !== 'string' || !/^phase[1-9][0-9]*$/.test(value))
        throw new TypeError('Invalid Claude replay workflowPhase');
      continue;
    }
    if (key === 'segment') {
      if (value !== true) throw new TypeError('Invalid Claude replay segment');
      continue;
    }
    if (key.endsWith('Set')) {
      if (!Array.isArray(value))
        throw new TypeError(`Invalid Claude replay ${key}`);
      const seen = new Set();
      for (const item of value) {
        if (
          typeof item !== 'string' ||
          !SAFE_SYMBOL.test(item) ||
          seen.has(item)
        )
          throw new TypeError(`Invalid Claude replay ${key}`);
        if (key === 'backgroundMembersSet' && !/^k[1-9][0-9]*$/.test(item))
          throw new TypeError('Invalid Claude replay background task alias');
        if (key === 'activeFlagsSet' && !CODEX_ACTIVE_FLAGS.includes(item))
          throw new TypeError('Unsupported Claude replay active flag');
        seen.add(item);
      }
      continue;
    }
    if (key === 'subagentKind') {
      if (!CODEX_SUBAGENT_ACTIVITY_KINDS.includes(value))
        throw new TypeError('Unsupported Claude replay subagentKind');
      continue;
    }
    if (typeof value === 'string') {
      if (!SAFE_SYMBOL.test(value))
        throw new TypeError(`Invalid Claude replay ${key}`);
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    throw new TypeError(`Invalid Claude replay ${key}`);
  }

  const resultSubtype = fields.resultSubtype;
  if (
    resultSubtype !== undefined &&
    (Array.isArray(resultSubtype) ||
      (TOOL_RESULT_STATUSES.has(resultSubtype) && !(type === 'sdk:user')))
  ) {
    throw new TypeError('Invalid Claude replay resultSubtype for frame');
  }
  return fields;
}

function parseType(type) {
  if (typeof type !== 'string' || !type.startsWith('sdk:'))
    throw new TypeError('Unsupported Claude replay frame type');
  const [, family, subtype, ...extra] = type.split(':');
  if (!family || extra.length > 0)
    throw new TypeError('Unsupported Claude replay frame type');
  const knownFamilies = new Set([
    'assistant',
    'auth_status',
    'conversation_reset',
    'command_lifecycle',
    'prompt_suggestion',
    'rate_limit_event',
    'result',
    'stream_event',
    'system',
    'tool_progress',
    'tool_use_summary',
    'user',
  ]);
  if (!knownFamilies.has(family))
    throw new TypeError('Unsupported Claude replay frame family');
  if (family === 'system') {
    if (!subtype || !CLAUDE_SYSTEM_SUBTYPES.includes(subtype))
      throw new TypeError('Unsupported Claude replay system subtype');
    return { family, subtype };
  }
  if (family === 'result') {
    if (!subtype || !RESULT_SUBTYPES.has(subtype))
      throw new TypeError('Unsupported Claude replay result subtype');
    return { family, subtype };
  }
  if (subtype !== undefined)
    throw new TypeError('Unsupported Claude replay frame subtype');
  return { family };
}

function templateKind(template) {
  if (typeof template !== 'string' || !CLAUDE_TEMPLATES.has(template))
    throw new TypeError('Unsupported Claude replay template');
  if (template === 'claude.sdk-message') return { generic: true };
  if (template === 'claude.stream-event') return { family: 'stream_event' };
  if (template === 'claude.result') return { family: 'result' };
  const parts = template.split('.');
  if (parts[0] !== 'claude')
    throw new TypeError('Unsupported Claude replay template');
  if (parts[1] === 'assistant') {
    const block = parts[2];
    if (!['blocks', 'text', 'thinking', 'tool_use'].includes(block))
      throw new TypeError('Unsupported Claude replay assistant template');
    return { family: 'assistant', block };
  }
  if (parts[1] === 'system' && parts.length >= 3)
    return { family: 'system', subtype: parts.slice(2).join('_') };
  throw new TypeError('Unsupported Claude replay template');
}

function validateFrame(frame) {
  assertRecord(frame, 'Claude replay frame');
  for (const key of Object.keys(frame)) {
    if (!FRAME_KEYS.has(key))
      throw new TypeError('Unsupported Claude replay frame property');
  }
  if (frame.kind !== 'frame')
    throw new TypeError('Expected a Claude replay frame');
  if (frame.lane !== 'root') {
    if (
      typeof frame.lane !== 'string' ||
      !/^child:[a-z][1-9][0-9]*$/.test(frame.lane)
    ) {
      throw new TypeError('Invalid Claude replay lane');
    }
  }
  const kind = parseType(frame.type);
  const template = templateKind(frame.template);
  if (!template.generic && template.family !== kind.family)
    throw new TypeError('Claude replay frame type/template mismatch');
  if (template.subtype !== undefined && template.subtype !== kind.subtype) {
    throw new TypeError('Claude replay frame type/template subtype mismatch');
  }
  if (frame.shape !== undefined) {
    if (
      !Array.isArray(frame.shape) ||
      frame.shape.length === 0 ||
      frame.shape.some((value) => typeof value !== 'string')
    ) {
      throw new TypeError('Invalid Claude replay shape');
    }
    const allowedShapes = new Set([
      ...CLAUDE_BLOCK_TYPES,
      ...CLAUDE_STREAM_EVENT_TYPES,
      ...CLAUDE_STREAM_DELTA_TYPES,
    ]);
    if (frame.shape.some((value) => !allowedShapes.has(value)))
      throw new TypeError('Unsupported Claude replay shape');
  }
  if (frame.ids !== undefined) {
    assertRecord(frame.ids, 'Claude replay identifiers');
    for (const [idKind, alias] of Object.entries(frame.ids))
      assertAlias(idKind, alias);
  }
  if (frame.consumed !== undefined) {
    if (
      !Array.isArray(frame.consumed) ||
      frame.consumed.some(
        (alias) => typeof alias !== 'string' || !SAFE_MESSAGE_ALIAS.test(alias),
      )
    ) {
      throw new TypeError('Invalid Claude replay consumed aliases');
    }
  }
  const fields = validateFields(frame.fields, frame.type);
  if (
    fields.resultSubtype !== undefined &&
    kind.family === 'result' &&
    fields.resultSubtype !== kind.subtype
  ) {
    throw new TypeError('Claude replay result subtype mismatch');
  }
  if (
    kind.family === 'command_lifecycle' &&
    fields.commandState !== undefined &&
    !CLAUDE_COMMAND_STATES.includes(fields.commandState)
  ) {
    throw new TypeError('Unsupported Claude command lifecycle state');
  }
  return { kind, template, fields };
}

function stopReason(fields, fallback) {
  const value = fields.stopReason;
  if (value === undefined) return fallback;
  if (value === null) return null;
  return assertEnum(value, CLAUDE_STOP_REASONS, 'stop reason');
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    inference_geo: '',
    iterations: [],
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  };
}

function toolInput() {
  return { command: REPLAY_TOOL_INPUT.command };
}

function makeMessage(id, sessionId, message) {
  return { ...message, uuid: id, session_id: sessionId };
}

function validateFixtureForLookup(fixture) {
  if (fixture === undefined) return undefined;
  assertRecord(fixture, 'Claude replay fixture');
  if (fixture.provider !== undefined && fixture.provider !== 'claude')
    throw new TypeError('Claude materializer requires a Claude fixture');
  if (!Array.isArray(fixture.steps))
    throw new TypeError('Claude replay fixture must contain steps');
  return fixture;
}

function replayAgentDescription(alias) {
  const suffix = /^[ku]([1-9][0-9]*)$/.exec(alias ?? '')?.[1];
  return `Claude lifecycle replay agent ${suffix ?? 'synthetic'}`;
}

function buildNativeAgentDescriptions(fixture) {
  const taskDescriptions = new Map();
  const toolUseDescriptions = new Map();
  // A composed fixture marks a Monitor call with a `monitor-tool/<alias>`
  // semantics label; recordings never do.
  const monitorToolUses = new Set(
    (fixture?.semantics ?? []).flatMap(
      (label) => MONITOR_TOOL_SEMANTICS.exec(label)?.[1] ?? [],
    ),
  );
  // Likewise a CronCreate call, with `cron-tool/<alias>`.
  const cronToolUses = new Set(
    (fixture?.semantics ?? []).flatMap(
      (label) => CRON_TOOL_SEMANTICS.exec(label)?.[1] ?? [],
    ),
  );
  for (const { step } of collectScheduledSteps(fixture)) {
    if (
      step.kind === 'frame' &&
      step.type === 'sdk:system:task_started' &&
      step.ids?.task &&
      monitorToolUses.has(step.ids?.toolUse)
    ) {
      taskDescriptions.set(step.ids.task, REPLAY_MONITOR_DESCRIPTION);
      continue;
    }
    if (
      step.kind !== 'frame' ||
      step.type !== 'sdk:system:task_started' ||
      !['agent', 'local_agent'].includes(step.fields?.taskType) ||
      !step.ids?.task ||
      !step.ids?.toolUse
    ) {
      continue;
    }
    const description = replayAgentDescription(step.ids.task);
    taskDescriptions.set(step.ids.task, description);
    toolUseDescriptions.set(step.ids.toolUse, description);
  }
  return {
    taskDescriptions,
    toolUseDescriptions,
    monitorToolUses,
    cronToolUses,
  };
}

function syntheticAgentInput(description) {
  return {
    subagent_type: 'Explore',
    description,
    prompt: `Review the synthetic lifecycle replay for ${description}.`,
    run_in_background: true,
  };
}

function materializeToolUse(
  frame,
  index,
  streamToolUseAliases,
  resolveId,
  nativeAgentDescriptions,
) {
  const toolUseAlias = frame.ids?.toolUse ?? streamToolUseAliases.get(index);
  const description =
    nativeAgentDescriptions.toolUseDescriptions.get(toolUseAlias);
  const id = outputToolUseId(frame, index, streamToolUseAliases, resolveId);
  if (nativeAgentDescriptions.cronToolUses.has(toolUseAlias)) {
    return {
      type: 'tool_use',
      id,
      name: 'CronCreate',
      input: {
        cron: '0 9 * * *',
        prompt: REPLAY_CRON_PROMPT,
        recurring: false,
      },
    };
  }
  if (nativeAgentDescriptions.monitorToolUses.has(toolUseAlias)) {
    return {
      type: 'tool_use',
      id,
      name: 'Monitor',
      input: { ...toolInput(), description: REPLAY_MONITOR_DESCRIPTION },
    };
  }
  if (description) {
    return {
      type: 'tool_use',
      id,
      name: 'Agent',
      input: syntheticAgentInput(description),
    };
  }
  return { type: 'tool_use', id, name: 'Bash', input: toolInput() };
}

function remapFixtureStep(
  step,
  { messageOffset, taskAliases, toolUseAliases },
) {
  const copy = JSON.parse(JSON.stringify(step));
  if (copy.ids?.message) {
    copy.ids.message = `m${Number(copy.ids.message.slice(1)) + messageOffset}`;
  }
  if (copy.ids?.task && taskAliases[copy.ids.task]) {
    copy.ids.task = taskAliases[copy.ids.task];
  }
  if (copy.ids?.toolUse && toolUseAliases[copy.ids.toolUse]) {
    copy.ids.toolUse = toolUseAliases[copy.ids.toolUse];
  }
  if (copy.lane?.startsWith('child:') && toolUseAliases[copy.lane.slice(6)]) {
    copy.lane = `child:${toolUseAliases[copy.lane.slice(6)]}`;
  }
  return copy;
}

/**
 * Compose only recorded Claude lifecycle slices for the Electron stop test.
 * Inputs stay immutable; the returned, validated fixture is written only to
 * the test's temporary user-data directory, never back into the recordings.
 */
export function composeClaudeTwoAgentStopFixture({
  agentFixture,
  interruptFixture,
  stopTaskFixture,
} = {}) {
  for (const fixture of [agentFixture, interruptFixture, stopTaskFixture]) {
    validateFixture(fixture);
    if (fixture.provider !== 'claude')
      throw new TypeError(
        'Claude stop fixture composition requires Claude inputs',
      );
  }

  const agentSteps = agentFixture.steps;
  const firstTaskStartedIndex = agentSteps.findIndex(
    (step) => step.type === 'sdk:system:task_started',
  );
  const firstToolUse = agentSteps.find(
    (step) =>
      step.kind === 'frame' &&
      step.type === 'sdk:assistant' &&
      step.shape?.includes('tool_use'),
  );
  const firstToolUseAlias = firstToolUse?.ids?.toolUse;
  const asyncLaunchIndex = agentSteps.findIndex(
    (step) => step.fields?.resultSubtype === 'async_launched',
  );
  const secondStartIndex = agentSteps.findIndex(
    (step) =>
      step.kind === 'frame' &&
      step.type === 'sdk:stream_event' &&
      step.shape?.[0] === 'message_start',
  );
  const foregroundAssistantIndex = agentSteps.findIndex(
    (step, index) =>
      index > asyncLaunchIndex &&
      step.kind === 'frame' &&
      step.type === 'sdk:assistant' &&
      step.shape?.includes('text'),
  );
  const interruptIndex = interruptFixture.steps.findIndex(
    (step) => step.kind === 'control' && step.action === 'interrupt',
  );
  const canceledResult = interruptFixture.steps.find(
    (step) => step.type === 'sdk:result:error_during_execution',
  );
  const stopTaskIndex = stopTaskFixture.steps.findIndex(
    (step) => step.kind === 'control' && step.action === 'stop-task',
  );
  const siblingReleaseIndex = agentSteps.findIndex(
    (step) =>
      step.kind === 'control' &&
      step.action === 'release' &&
      step.barrier === 'child-finish',
  );
  const siblingTaskNotificationIndex = agentSteps.findIndex(
    (step, index) =>
      index > siblingReleaseIndex &&
      step.type === 'sdk:system:task_notification' &&
      step.fields?.taskStatus === 'completed',
  );
  if (
    firstTaskStartedIndex < 0 ||
    !firstToolUseAlias ||
    asyncLaunchIndex < 0 ||
    secondStartIndex < 0 ||
    foregroundAssistantIndex < 0 ||
    interruptIndex < 0 ||
    !canceledResult ||
    stopTaskIndex < 0 ||
    siblingReleaseIndex < 0 ||
    siblingTaskNotificationIndex < 0
  ) {
    throw new TypeError('Recorded Claude stop fixture slices are incomplete');
  }

  const secondTaskAlias = 'k2';
  const secondToolUseAlias = 'u2';
  const firstAgentLaunch = agentSteps.slice(0, asyncLaunchIndex + 1);
  const secondAgentLaunch = agentSteps
    .slice(secondStartIndex, asyncLaunchIndex + 1)
    .map((step) =>
      remapFixtureStep(step, {
        messageOffset: 20,
        taskAliases: { k1: secondTaskAlias },
        toolUseAliases: { [firstToolUseAlias]: secondToolUseAlias },
      }),
    );
  for (const step of secondAgentLaunch) {
    if (step.type === 'sdk:system:background_tasks_changed') {
      step.fields.backgroundMembersSet = ['k1', secondTaskAlias];
    }
  }

  const foregroundPrefix = agentSteps.slice(
    asyncLaunchIndex + 1,
    foregroundAssistantIndex + 1,
  );
  const stopFrames = stopTaskFixture.steps
    .slice(stopTaskIndex + 1)
    .filter((step) =>
      [
        'sdk:system:background_tasks_changed',
        'sdk:system:task_updated',
        'sdk:system:task_notification',
      ].includes(step.type),
    )
    .map((step) =>
      remapFixtureStep(step, {
        messageOffset: 40,
        taskAliases: { k1: secondTaskAlias },
        toolUseAliases: { [firstToolUseAlias]: secondToolUseAlias },
      }),
    );
  for (const step of stopFrames) {
    if (step.type === 'sdk:system:background_tasks_changed') {
      step.fields.backgroundMembersSet = ['k1'];
    }
  }

  const siblingFinish = agentSteps
    .slice(siblingReleaseIndex, siblingTaskNotificationIndex + 1)
    .map((step, index) => {
      const copy = remapFixtureStep(step, {
        messageOffset: 60,
        taskAliases: {},
        toolUseAliases: {},
      });
      if (index === 0) copy.barrier = 'sibling-finish';
      return copy;
    });
  const canceled = remapFixtureStep(canceledResult, {
    messageOffset: 80,
    taskAliases: {},
    toolUseAliases: {},
  });
  const fixture = {
    ...agentFixture,
    scenario: 'two-native-agents-foreground-interrupt-stop-one',
    semantics: [
      'foreground-interrupt-preserves-native-agents',
      'stop-task-targets-one-native-agent',
    ],
    steps: [
      ...firstAgentLaunch,
      ...secondAgentLaunch,
      ...foregroundPrefix,
      interruptFixture.steps[interruptIndex],
      canceled,
      { kind: 'control', action: 'stop-task', ids: { task: secondTaskAlias } },
      ...stopFrames,
      ...siblingFinish,
    ],
  };
  return validateFixture(fixture);
}

function collectScheduledSteps(fixture) {
  return fixture ? scheduleSteps(fixture) : [];
}

function hasToolUseBlock(frame) {
  if (
    !isRecord(frame) ||
    frame.kind !== 'frame' ||
    frame.type !== 'sdk:assistant'
  )
    return false;
  if (frame.shape?.includes('tool_use')) return true;
  return frame.template === 'claude.assistant.tool_use';
}

function hasStreamToolUseStart(frame) {
  return (
    isRecord(frame) &&
    frame.kind === 'frame' &&
    frame.type === 'sdk:stream_event' &&
    frame.shape?.[0] === 'content_block_start' &&
    frame.shape?.[1] === 'tool_use'
  );
}

function buildToolUseLookahead(fixture) {
  const scheduled = collectScheduledSteps(fixture);
  const associations = new Map();
  const usedAssistantFrames = new Set();
  for (let index = 0; index < scheduled.length; index += 1) {
    const { step } = scheduled[index];
    if (
      step.kind !== 'frame' ||
      !hasStreamToolUseStart(step) ||
      step.ids?.toolUse
    )
      continue;
    const messageAlias = step.ids?.message;
    if (!messageAlias)
      throw new TypeError(
        'Stream tool-use replay frame requires a message alias',
      );
    let match;
    for (
      let lookahead = index + 1;
      lookahead < scheduled.length;
      lookahead += 1
    ) {
      const candidate = scheduled[lookahead].step;
      if (
        candidate.kind === 'frame' &&
        hasToolUseBlock(candidate) &&
        candidate.ids?.message === messageAlias &&
        typeof candidate.ids?.toolUse === 'string' &&
        !usedAssistantFrames.has(lookahead)
      ) {
        match = { lookahead, alias: candidate.ids.toolUse };
        break;
      }
    }
    if (!match)
      throw new TypeError(
        'Stream tool-use replay frame has no assistant tool alias',
      );
    usedAssistantFrames.add(match.lookahead);
    associations.set(scheduled[index].index, match.alias);
  }
  return associations;
}

function validateShapeForKind(frame, kind, template) {
  const shape = frame.shape ?? [];
  const fields = frame.fields ?? {};
  if (kind.family === 'stream_event') {
    const eventKind = shape[0] ?? 'message_stop';
    if (!STREAM_EVENT_SET.has(eventKind))
      throw new TypeError('Unsupported Claude stream event shape');
    if (eventKind === 'content_block_start') {
      if (
        shape.length !== 2 ||
        !['text', 'thinking', 'tool_use'].includes(shape[1])
      )
        throw new TypeError('Unsupported Claude stream content block');
    } else if (eventKind === 'content_block_delta') {
      if (shape.length !== 2 || !STREAM_DELTA_SET.has(shape[1]))
        throw new TypeError('Unsupported Claude stream delta');
      if (
        !['input_json_delta', 'thinking_delta', 'text_delta'].includes(shape[1])
      )
        throw new TypeError('Unsupported Claude stream delta');
    } else if (shape.length > 1) {
      throw new TypeError('Unsupported Claude stream event shape');
    }
    return;
  }
  if (kind.family === 'assistant') {
    if (
      shape.some((block) => !['text', 'thinking', 'tool_use'].includes(block))
    )
      throw new TypeError('Unsupported Claude assistant content shape');
    const declaredBlock = template.block;
    if (declaredBlock && declaredBlock !== 'blocks') {
      const actualBlocks = shape.length > 0 ? shape : [declaredBlock];
      if (actualBlocks.length !== 1 || actualBlocks[0] !== declaredBlock)
        throw new TypeError('Claude assistant template/shape mismatch');
    }
    if (declaredBlock === 'blocks' && shape.length === 0)
      throw new TypeError('Claude assistant blocks template requires a shape');
    if (shape.filter((block) => block === 'tool_use').length > 1)
      throw new TypeError(
        'Claude assistant frame has multiple tool-use blocks',
      );
    if (shape.includes('tool_use') && !frame.ids?.toolUse)
      throw new TypeError(
        'Claude assistant tool-use frame requires a tool alias',
      );
    return;
  }
  if (kind.family === 'user') {
    if (shape.some((block) => !['text', 'tool_result'].includes(block)))
      throw new TypeError('Unsupported Claude user content shape');
    if (shape.includes('tool_result') && !frame.ids?.toolUse)
      throw new TypeError(
        'Claude user tool-result frame requires a tool alias',
      );
    const status = fields.resultSubtype;
    if (status !== undefined && !TOOL_RESULT_STATUSES.has(status))
      throw new TypeError('Unsupported Claude tool-result status');
    return;
  }
  if (shape.length > 0)
    throw new TypeError('Claude replay shape is not valid for this frame type');
}

function resolveTemplateAndKind(frame) {
  const validated = validateFrame(frame);
  validateShapeForKind(frame, validated.kind, validated.template);
  return validated;
}

function outputToolUseId(frame, index, streamToolUseAliases, resolveId) {
  const alias = frame.ids?.toolUse ?? streamToolUseAliases.get(index);
  if (typeof alias !== 'string')
    throw new TypeError('Claude replay tool-use identifier is not bound');
  return resolveId('toolUse', alias);
}

function outputParentToolUseId(frame, resolveId) {
  if (!frame.lane.startsWith('child:')) return null;
  return resolveId('toolUse', frame.lane.slice('child:'.length));
}

function createMaterializerState(sessionId, fixture) {
  const messageBindings = new Map();
  const generatedMessageIds = new Map();
  const aliases = new Map();
  const receiptAliases = new Set();
  const sendAliases = new Set();

  const bindAlias = (kind, alias, actualId) => {
    const checkedAlias = assertAlias(kind, alias);
    const key = `${kind}:${checkedAlias}`;
    const existing = aliases.get(key);
    if (existing !== undefined && existing !== actualId)
      throw new Error(`Claude replay alias ${key} was rebound`);
    aliases.set(key, actualId);
    return actualId;
  };

  const resolveId = (kind, alias, index) => {
    if (kind === 'session') {
      if (alias !== undefined) bindAlias('session', alias, sessionId);
      return sessionId;
    }
    if (kind === 'message') {
      if (alias !== undefined) {
        assertAlias(kind, alias);
        const live = messageBindings.get(alias);
        if (live) return bindAlias(kind, alias, live);
        if (receiptAliases.has(alias) || sendAliases.has(alias))
          throw new Error(
            `Claude input message alias ${alias} has no live UUID binding`,
          );
        const generated = generatedMessageIds.get(alias);
        if (generated) return bindAlias(kind, alias, generated);
        const id = randomUUID();
        generatedMessageIds.set(alias, id);
        return bindAlias(kind, alias, id);
      }
      const autoAlias = `$frame:${index}`;
      const generated = generatedMessageIds.get(autoAlias) ?? randomUUID();
      generatedMessageIds.set(autoAlias, generated);
      return generated;
    }
    const resolvedAlias = alias ?? `$frame:${index}`;
    if (alias !== undefined) assertAlias(kind, alias);
    const key = `${kind}:${resolvedAlias}`;
    const existing = aliases.get(key);
    if (existing !== undefined) return existing;
    const id =
      kind === 'toolUse' || kind === 'call'
        ? `toolu_${randomUUID()}`
        : kind === 'task'
          ? `task_${randomUUID()}`
          : kind === 'request'
            ? `req_${randomUUID()}`
            : kind === 'thread'
              ? `thread_${randomUUID()}`
              : kind === 'item'
                ? `item_${randomUUID()}`
                : `turn_${randomUUID()}`;
    aliases.set(key, id);
    return id;
  };

  const validatedFixture = validateFixtureForLookup(fixture);
  const nativeAgentDescriptions =
    buildNativeAgentDescriptions(validatedFixture);
  if (validatedFixture) {
    for (const { step } of collectScheduledSteps(validatedFixture)) {
      if (step.kind === 'control' && ['send', 'steer'].includes(step.action)) {
        if (step.ids?.message) {
          assertAlias('message', step.ids.message);
          sendAliases.add(step.ids.message);
        }
      }
      if (step.kind === 'frame' && step.type === 'sdk:command_lifecycle') {
        if (!step.ids?.message)
          throw new TypeError(
            'Claude command receipt requires a message alias',
          );
        assertAlias('message', step.ids.message);
        receiptAliases.add(step.ids.message);
      }
    }
    // A receipt no send names is a command the CLI started itself, as a cron
    // job's fire, so its uuid is minted like any other frame's.
    for (const alias of Array.from(receiptAliases))
      if (!sendAliases.has(alias)) receiptAliases.delete(alias);
  }

  return {
    receiptAliases,
    sendAliases,
    nativeAgentDescriptions,
    streamToolUseAliases: buildToolUseLookahead(validatedFixture),
    bindMessage(alias, actualUuid) {
      assertAlias('message', alias);
      if (typeof actualUuid !== 'string' || !UUID_PATTERN.test(actualUuid))
        throw new TypeError('Claude replay live message id must be a UUID');
      const existing = messageBindings.get(alias);
      if (existing !== undefined && existing !== actualUuid)
        throw new Error(`Claude replay message alias ${alias} was rebound`);
      const generated = generatedMessageIds.get(alias);
      if (generated !== undefined && generated !== actualUuid)
        throw new Error(
          `Claude replay message alias ${alias} was already materialized`,
        );
      messageBindings.set(alias, actualUuid);
      generatedMessageIds.set(alias, actualUuid);
      bindAlias('message', alias, actualUuid);
    },
    resolveId,
    resolveReceiptMessage(alias) {
      if (typeof alias !== 'string')
        throw new TypeError('Claude command receipt has no message alias');
      assertAlias('message', alias);
      const bound = messageBindings.get(alias);
      if (!bound)
        throw new Error(
          `Claude command receipt message alias ${alias} has no live binding`,
        );
      return bindAlias('message', alias, bound);
    },
    resolveConsumed(alias) {
      assertAlias('message', alias);
      const bound = messageBindings.get(alias);
      if (!bound)
        throw new Error(
          `Claude replay consumed input alias ${alias} has no live UUID binding`,
        );
      return bindAlias('message', alias, bound);
    },
  };
}

function attachConsumedIds(envelope, frame, resolveConsumed) {
  if (!Array.isArray(frame.consumed) || frame.consumed.length === 0)
    return envelope;
  const messageUuids = frame.consumed.map((alias) => resolveConsumed(alias));
  envelope.user_message_uuids = messageUuids;
  envelope.user_message_uuid = messageUuids.at(-1);
  return envelope;
}

function materializeSystem(
  frame,
  kind,
  fields,
  messageUuid,
  sessionId,
  resolveId,
  nativeAgentDescriptions,
) {
  const subtype = kind.subtype;
  if (subtype === 'compact_boundary') {
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      compact_metadata: { trigger: 'manual', pre_tokens: 0 },
    });
  }
  if (subtype === 'init') {
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      apiKeySource: 'none',
      claude_code_version: 'scripted',
      cwd: '',
      tools: [],
      mcp_servers: [],
      model: 'scripted-claude',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    });
  }
  if (subtype === 'status') {
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      status: null,
    });
  }
  if (subtype === 'session_state_changed') {
    const state = assertEnum(
      fields.sessionState ?? 'running',
      CLAUDE_SESSION_STATES,
      'session state',
    );
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      state,
    });
  }
  if (subtype === 'background_tasks_changed') {
    const members = fields.backgroundMembersSet ?? [];
    if (!Array.isArray(members))
      throw new TypeError('Invalid Claude background task set');
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      tasks: members.map((alias) => ({
        task_id: resolveId('task', alias, 0),
        task_type: 'local_agent',
        description:
          nativeAgentDescriptions.taskDescriptions.get(alias) ?? REPLAY_TEXT,
      })),
    });
  }
  if (subtype === 'task_started') {
    const taskId = frame.ids?.task;
    if (!taskId)
      throw new TypeError('Claude task_started requires a task alias');
    const envelope = {
      type: 'system',
      subtype,
      task_id: resolveId('task', taskId, 0),
      description:
        nativeAgentDescriptions.taskDescriptions.get(taskId) ?? REPLAY_TEXT,
    };
    if (frame.ids?.toolUse)
      envelope.tool_use_id = resolveId('toolUse', frame.ids.toolUse, 0);
    if (fields.taskType !== undefined)
      envelope.task_type = assertEnum(
        fields.taskType,
        CLAUDE_TASK_TYPES,
        'task type',
      );
    if (fields.isBackgrounded !== undefined)
      envelope.is_backgrounded = fields.isBackgrounded;
    return makeMessage(messageUuid, sessionId, envelope);
  }
  if (subtype === 'task_notification') {
    const taskId = frame.ids?.task;
    if (!taskId)
      throw new TypeError('Claude task_notification requires a task alias');
    const status = assertEnum(
      fields.taskStatus ?? 'completed',
      ['completed', 'failed', 'stopped'],
      'task notification status',
    );
    const envelope = {
      type: 'system',
      subtype,
      task_id: resolveId('task', taskId, 0),
      status,
      output_file: 'synthetic-replay-output.txt',
      summary: REPLAY_TEXT,
    };
    if (frame.ids?.toolUse)
      envelope.tool_use_id = resolveId('toolUse', frame.ids.toolUse, 0);
    return makeMessage(messageUuid, sessionId, envelope);
  }
  if (subtype === 'task_updated') {
    const taskId = frame.ids?.task;
    if (!taskId)
      throw new TypeError('Claude task_updated requires a task alias');
    const patch = {};
    if (fields.taskStatus !== undefined) {
      patch.status = assertEnum(
        fields.taskStatus,
        ['pending', 'running', 'completed', 'failed', 'killed', 'paused'],
        'task update status',
      );
    }
    if (fields.isBackgrounded !== undefined)
      patch.is_backgrounded = fields.isBackgrounded;
    return makeMessage(messageUuid, sessionId, {
      type: 'system',
      subtype,
      task_id: resolveId('task', taskId, 0),
      patch,
    });
  }
  throw new TypeError('Unsupported Claude system replay subtype');
}

function materializeStream(
  frame,
  shape,
  fields,
  messageUuid,
  sessionId,
  index,
  streamToolUseAliases,
  resolveId,
  nativeAgentDescriptions,
) {
  const eventKind = shape[0] ?? 'message_stop';
  let event;
  if (eventKind === 'message_stop') {
    event = { type: 'message_stop' };
  } else if (eventKind === 'ping') {
    event = { type: 'ping' };
  } else if (eventKind === 'message_start') {
    event = {
      type: 'message_start',
      message: {
        id: messageUuid,
        type: 'message',
        container: null,
        context_management: null,
        diagnostics: null,
        stop_details: null,
        role: 'assistant',
        model: 'scripted-claude',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
    };
  } else if (eventKind === 'message_delta') {
    event = {
      type: 'message_delta',
      context_management: null,
      delta: {
        container: null,
        stop_details: null,
        stop_reason: stopReason(fields, 'end_turn'),
        stop_sequence: null,
      },
      usage: emptyUsage(),
    };
  } else if (eventKind === 'content_block_stop') {
    event = { type: 'content_block_stop', index: 0 };
  } else if (eventKind === 'content_block_start') {
    const block = shape[1];
    if (block === 'tool_use') {
      event = {
        type: 'content_block_start',
        index: 0,
        content_block: materializeToolUse(
          frame,
          index,
          streamToolUseAliases,
          resolveId,
          nativeAgentDescriptions,
        ),
      };
    } else if (block === 'thinking') {
      event = {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: REPLAY_TEXT,
          signature: 'synthetic-replay-signature',
        },
      };
    } else if (block === 'text') {
      event = {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: REPLAY_TEXT, citations: null },
      };
    } else {
      throw new TypeError('Unsupported Claude stream content block');
    }
  } else if (eventKind === 'content_block_delta') {
    const deltaKind = shape[1];
    if (deltaKind === 'input_json_delta') {
      event = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      };
    } else if (deltaKind === 'thinking_delta') {
      event = {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: REPLAY_TEXT,
          estimated_tokens: null,
        },
      };
    } else if (deltaKind === 'text_delta') {
      event = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: REPLAY_TEXT },
      };
    } else {
      throw new TypeError('Unsupported Claude stream delta');
    }
  } else {
    throw new TypeError('Unsupported Claude stream event');
  }
  return makeMessage(messageUuid, sessionId, {
    type: 'stream_event',
    event,
    parent_tool_use_id: outputParentToolUseId(frame, resolveId),
  });
}

function materializeAssistant(
  frame,
  template,
  fields,
  messageUuid,
  sessionId,
  index,
  streamToolUseAliases,
  resolveId,
  nativeAgentDescriptions,
) {
  const declaredBlock = template.block;
  const shape =
    frame.shape ??
    (declaredBlock && declaredBlock !== 'blocks' ? [declaredBlock] : []);
  const content = [];
  for (const block of shape) {
    if (block === 'text') {
      content.push({ type: 'text', text: REPLAY_TEXT, citations: null });
    } else if (block === 'thinking') {
      content.push({
        type: 'thinking',
        thinking: REPLAY_TEXT,
        signature: 'synthetic-replay-signature',
      });
    } else if (block === 'tool_use') {
      content.push(
        materializeToolUse(
          frame,
          index,
          streamToolUseAliases,
          resolveId,
          nativeAgentDescriptions,
        ),
      );
    } else {
      throw new TypeError('Unsupported Claude assistant content block');
    }
  }
  return makeMessage(messageUuid, sessionId, {
    type: 'assistant',
    message: {
      id: messageUuid,
      type: 'message',
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
      role: 'assistant',
      model: 'scripted-claude',
      content,
      stop_reason: stopReason(fields, null),
      stop_sequence: null,
      usage: emptyUsage(),
    },
    parent_tool_use_id: outputParentToolUseId(frame, resolveId),
    ...(frame.ids?.request
      ? { request_id: resolveId('request', frame.ids.request, index) }
      : {}),
  });
}

function materializeResult(frame, kind, fields, messageUuid, sessionId) {
  const isError = fields.isError ?? kind.subtype !== 'success';
  const shared = {
    type: 'result',
    subtype: kind.subtype,
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: isError,
    num_turns: 1,
    stop_reason: stopReason(
      fields,
      kind.subtype === 'success' ? 'end_turn' : 'error',
    ),
    total_cost_usd: 0,
    usage: emptyUsage(),
    modelUsage: {},
    permission_denials: [],
    uuid: messageUuid,
    session_id: sessionId,
  };
  if (fields.resultIndex !== undefined)
    shared.result_index = fields.resultIndex;
  if (fields.terminalReason !== undefined)
    shared.terminal_reason = assertEnum(
      fields.terminalReason,
      CLAUDE_TERMINAL_REASONS,
      'terminal reason',
    );
  if (fields.originKind !== undefined)
    shared.origin = {
      kind: assertEnum(fields.originKind, CLAUDE_ORIGIN_KINDS, 'origin kind'),
    };
  if (kind.subtype === 'success') return { ...shared, result: REPLAY_TEXT };
  return { ...shared, errors: [REPLAY_TEXT] };
}

function materializeUser(
  frame,
  fields,
  messageUuid,
  sessionId,
  resolveId,
  cronToolUses,
) {
  const content = [];
  for (const block of frame.shape ?? []) {
    if (block === 'text') {
      content.push({ type: 'text', text: REPLAY_TEXT });
    } else if (block === 'tool_result') {
      content.push({
        type: 'tool_result',
        tool_use_id: resolveId('toolUse', frame.ids?.toolUse, 0),
        content: REPLAY_TOOL_RESULT,
      });
    } else {
      throw new TypeError('Unsupported Claude user content block');
    }
  }
  const envelope = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: outputParentToolUseId(frame, resolveId),
  };
  if (
    fields.resultSubtype !== undefined &&
    TOOL_RESULT_STATUSES.has(fields.resultSubtype)
  ) {
    envelope.tool_use_result = { status: fields.resultSubtype };
  }
  // A CronCreate result reports the job it scheduled, as the CLI does.
  if (cronToolUses?.has(frame.ids?.toolUse)) {
    envelope.tool_use_result = {
      id: `replay-job-${frame.ids.toolUse}`,
      humanSchedule: 'Every day at 9:00',
      recurring: false,
      durable: false,
    };
  }
  return makeMessage(messageUuid, sessionId, envelope);
}

function materializeToolProgress(
  frame,
  messageUuid,
  sessionId,
  index,
  resolveId,
) {
  const toolUseAlias = frame.ids?.toolUse;
  if (!toolUseAlias)
    throw new TypeError('Claude tool_progress requires a tool-use alias');
  const envelope = {
    type: 'tool_progress',
    tool_use_id: resolveId('toolUse', toolUseAlias, index),
    tool_name: 'Bash',
    parent_tool_use_id: outputParentToolUseId(frame, resolveId),
    elapsed_time_seconds: 1,
  };
  if (frame.ids?.task)
    envelope.task_id = resolveId('task', frame.ids.task, index);
  return makeMessage(messageUuid, sessionId, envelope);
}

/**
 * Create a materializer bound to the live Claude query session.
 *
 * `fixture` is optional and is used only to associate a stream tool-use start
 * with the subsequent assistant tool-use alias when the stream frame omits it.
 */
export function createClaudeMaterializer({ sessionId, fixture } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    throw new TypeError('Claude materializer requires a live session id');
  const state = createMaterializerState(sessionId, fixture);

  return {
    bindMessage(alias, actualUuid) {
      state.bindMessage(alias, actualUuid);
    },
    materialize(frame, index) {
      if (!Number.isSafeInteger(index) || index < 0)
        throw new TypeError(
          'Claude replay frame index must be a non-negative integer',
        );
      const { kind, template, fields } = resolveTemplateAndKind(frame);

      if (kind.family === 'command_lifecycle') {
        const alias = frame.ids?.message;
        const commandUuid = state.receiptAliases.has(alias)
          ? state.resolveReceiptMessage(alias)
          : state.resolveId('message', alias, index);
        const stateValue = assertEnum(
          fields.commandState ?? 'started',
          CLAUDE_COMMAND_STATES,
          'command lifecycle state',
        );
        return {
          type: 'command_lifecycle',
          command_uuid: commandUuid,
          session_id: sessionId,
          state: stateValue,
        };
      }

      const messageUuid = state.resolveId('message', frame.ids?.message, index);
      if (kind.family === 'stream_event') {
        return attachConsumedIds(
          materializeStream(
            frame,
            frame.shape ?? [],
            fields,
            messageUuid,
            sessionId,
            index,
            state.streamToolUseAliases,
            state.resolveId,
            state.nativeAgentDescriptions,
          ),
          frame,
          state.resolveConsumed,
        );
      }
      if (kind.family === 'assistant') {
        return attachConsumedIds(
          materializeAssistant(
            frame,
            template,
            fields,
            messageUuid,
            sessionId,
            index,
            state.streamToolUseAliases,
            state.resolveId,
            state.nativeAgentDescriptions,
          ),
          frame,
          state.resolveConsumed,
        );
      }
      if (kind.family === 'result')
        return attachConsumedIds(
          materializeResult(frame, kind, fields, messageUuid, sessionId),
          frame,
          state.resolveConsumed,
        );
      if (kind.family === 'user')
        return materializeUser(
          frame,
          fields,
          messageUuid,
          sessionId,
          state.resolveId,
          state.nativeAgentDescriptions.cronToolUses,
        );
      if (kind.family === 'system')
        return attachConsumedIds(
          materializeSystem(
            frame,
            kind,
            fields,
            messageUuid,
            sessionId,
            state.resolveId,
            state.nativeAgentDescriptions,
          ),
          frame,
          state.resolveConsumed,
        );
      if (kind.family === 'tool_progress')
        return materializeToolProgress(
          frame,
          messageUuid,
          sessionId,
          index,
          state.resolveId,
        );
      throw new TypeError('Unsupported Claude replay frame family');
    },
  };
}

/**
 * Compose the recorded background-shell wake into a Monitor event wake: the
 * root turn also starts a Monitor, whose event wakes an autonomous turn with
 * no finished-task notification before it (the result's origin names a task
 * notification). The shell's own wake follows. Gates: `monitor-event`, then
 * `helper-finished`.
 */
export function composeClaudeMonitorEventWakeFixture({ wakeFixture } = {}) {
  validateFixture(wakeFixture);
  if (wakeFixture.provider !== 'claude')
    throw new TypeError('Monitor event composition requires a Claude fixture');
  const steps = wakeFixture.steps;
  const expectStep = (index, predicate, label) => {
    if (!predicate(steps[index]))
      throw new TypeError(`Unexpected background wake recording at ${label}`);
    return index;
  };
  const isFrame = (type) => (step) =>
    step?.kind === 'frame' && step.type === type;
  const toolUseStart = expectStep(
    3,
    (step) => isFrame('sdk:stream_event')(step) && step.ids?.message === 'm4',
    'tool call',
  );
  const toolUseEnd = expectStep(
    9,
    (step) => isFrame('sdk:stream_event')(step) && step.ids?.message === 'm4',
    'tool call end',
  );
  const backgroundSet = expectStep(
    12,
    isFrame('sdk:system:background_tasks_changed'),
    'background set',
  );
  const taskStarted = expectStep(
    13,
    isFrame('sdk:system:task_started'),
    'task start',
  );
  const toolResult = expectStep(14, isFrame('sdk:user'), 'tool result');
  const rootResult = expectStep(
    23,
    isFrame('sdk:result:success'),
    'root result',
  );
  const release = expectStep(
    24,
    (step) => step?.kind === 'control' && step.action === 'release',
    'release',
  );
  const helperIdle = expectStep(
    25,
    isFrame('sdk:system:session_state_changed'),
    'idle',
  );
  const helperNotification = expectStep(
    27,
    isFrame('sdk:system:task_notification'),
    'helper notification',
  );
  const helperSet = expectStep(
    28,
    isFrame('sdk:system:background_tasks_changed'),
    'helper set',
  );
  const wakeStart = expectStep(
    29,
    isFrame('sdk:system:session_state_changed'),
    'wake start',
  );
  const wakeResult = expectStep(
    39,
    isFrame('sdk:result:success'),
    'wake result',
  );
  expectStep(40, isFrame('sdk:system:session_state_changed'), 'wake idle');

  let nextMessage = 100;
  const copyGroup = (from, to, edit = (step) => step) => {
    const aliases = new Map();
    return steps.slice(from, to + 1).map((source) => {
      const step = JSON.parse(JSON.stringify(source));
      if (step.ids?.message) {
        if (!aliases.has(step.ids.message))
          aliases.set(step.ids.message, `m${(nextMessage += 1)}`);
        step.ids.message = aliases.get(step.ids.message);
      }
      return edit(step);
    });
  };
  const withToolUse = (alias) => (step) => {
    if (step.ids?.toolUse) step.ids.toolUse = alias;
    return step;
  };
  const withFields = (fields) => (step) => ({
    ...step,
    fields: { ...step.fields, ...fields },
  });

  const monitorCall = [
    ...copyGroup(toolUseStart, toolUseEnd, withToolUse('u2')),
    ...copyGroup(
      backgroundSet,
      backgroundSet,
      withFields({ backgroundMembersSet: ['k1', 'k2'] }),
    ),
    ...copyGroup(taskStarted, taskStarted, (step) => {
      step.ids.task = 'k2';
      step.ids.toolUse = 'u2';
      return step;
    }),
    ...copyGroup(toolResult, toolResult, withToolUse('u2')),
  ];
  const monitorEventWake = copyGroup(wakeStart, wakeResult + 1, (step) =>
    step.type === 'sdk:result:success'
      ? withFields({ originKind: 'task-notification', resultIndex: 1 })(step)
      : step,
  );
  const fixture = {
    ...JSON.parse(JSON.stringify(wakeFixture)),
    scenario: 'monitor-event-wake',
    semantics: [...wakeFixture.semantics, 'monitor-tool/u2'],
    steps: [
      ...steps.slice(0, toolResult + 1),
      ...monitorCall,
      ...steps.slice(toolResult + 1, rootResult + 1),
      { ...steps[release], barrier: 'monitor-event' },
      steps[helperIdle],
      ...monitorEventWake,
      { ...steps[release], barrier: 'helper-finished' },
      ...steps.slice(helperIdle + 1, helperNotification + 1),
      withFields({ backgroundMembersSet: ['k2'] })(steps[helperSet]),
      ...steps
        .slice(wakeStart, wakeResult + 2)
        .map((step) =>
          step.type === 'sdk:result:success'
            ? withFields({ resultIndex: 2 })(step)
            : step,
        ),
    ].map((step) => JSON.parse(JSON.stringify(step))),
  };
  return validateFixture(fixture);
}

/**
 * Compose the recorded background-shell wake into a cron fire: the root turn
 * also schedules a one-shot prompt (`CronCreate`), whose fire starts an
 * autonomous turn with no notification before it and no origin on its result,
 * as the CLI reports one. The shell's own wake follows. Gates: `cron-fire`,
 * then `helper-finished`.
 */
export function composeClaudeCronFireWakeFixture({ wakeFixture } = {}) {
  const monitorFixture = composeClaudeMonitorEventWakeFixture({ wakeFixture });
  // Reuse the Monitor composition's layout; the Monitor call becomes a
  // CronCreate call with no task, and its event wake a fire with no origin.
  const steps = monitorFixture.steps.filter(
    (step) =>
      !(
        step.kind === 'frame' &&
        step.ids?.toolUse === 'u2' &&
        step.type === 'sdk:system:task_started'
      ) &&
      !(
        step.kind === 'frame' &&
        step.type === 'sdk:system:background_tasks_changed' &&
        JSON.stringify(step.fields?.backgroundMembersSet) ===
          JSON.stringify(['k1', 'k2'])
      ),
  );
  // The fire runs as a command the CLI starts itself, before its turn's init,
  // and completes after its result, as the CLI reports it.
  const fireCommand = (commandState) => ({
    kind: 'frame',
    lane: 'root',
    type: 'sdk:command_lifecycle',
    ids: { session: 's1', message: 'm111' },
    fields: { commandState },
    template: 'claude.sdk-message',
  });
  const fireResult = steps.findIndex(
    (step) =>
      step.kind === 'frame' &&
      step.type === 'sdk:result:success' &&
      step.fields?.resultIndex === 1,
  );
  const fireInit = steps.findLastIndex(
    (step, index) =>
      index < fireResult &&
      step.kind === 'frame' &&
      step.type === 'sdk:system:init',
  );
  steps.splice(fireResult + 1, 0, fireCommand('completed'));
  steps.splice(fireInit, 0, fireCommand('started'));
  const fixture = {
    ...monitorFixture,
    scenario: 'cron-fire-wake',
    semantics: [...wakeFixture.semantics, 'cron-tool/u2'],
    steps: steps.map((step) => {
      const copy = JSON.parse(JSON.stringify(step));
      if (copy.kind === 'control' && copy.barrier === 'monitor-event')
        copy.barrier = 'cron-fire';
      if (
        copy.kind === 'frame' &&
        copy.type === 'sdk:system:background_tasks_changed' &&
        JSON.stringify(copy.fields?.backgroundMembersSet) ===
          JSON.stringify(['k2'])
      )
        copy.fields.backgroundMembersSet = [];
      if (
        copy.kind === 'frame' &&
        copy.type === 'sdk:result:success' &&
        copy.fields?.resultIndex === 1
      )
        delete copy.fields.originKind;
      return copy;
    }),
  };
  return validateFixture(fixture);
}

/**
 * Replay delays (`CANOPY_LIFECYCLE_REPLAY_DELAYS`) that pace each wake like a
 * live session: its first frame after a released gate waits, as a task's
 * notification arrives after the previous reply settled, and its first reply
 * frame waits past the turn handoff's 2s fallback commit. A live session
 * commits a wake's start before its reply (thinking updates, for one); the
 * replay's bare burst would otherwise commit both in one transaction, which
 * appends the wake's timer row after its reply.
 */
export function wakeReplyDelays(
  fixture,
  { startMs = 300, replyMs = 2_500 } = {},
) {
  const delays = {};
  let afterRelease = false;
  let awaitingReply = false;
  for (const [index, step] of fixture.steps.entries()) {
    if (step.kind === 'control') {
      afterRelease = step.action === 'release';
      continue;
    }
    if (step.kind !== 'frame') continue;
    if (afterRelease) {
      delays[index] = startMs;
      afterRelease = false;
    }
    if (step.type === 'sdk:system:init')
      awaitingReply = index > 1 && step.lane === 'root';
    else if (awaitingReply && step.type === 'sdk:stream_event') {
      delays[index] = replyMs;
      awaitingReply = false;
    }
  }
  return delays;
}
