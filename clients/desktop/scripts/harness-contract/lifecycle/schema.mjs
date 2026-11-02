/**
 * C2 v2 lifecycle fixture contract.
 *
 * The finite event vocabularies below are copied from the installed Claude
 * SDK declarations and checked-in generated Codex app-server declarations.
 * Keep them synchronized with the harness surface inventory; never accept an
 * unknown event or status as a forward-compatible fallback.
 */

export const FIXTURE_SCHEMA_VERSION = 1;
export const PROVIDERS = Object.freeze(['claude', 'codex']);
export const TIERS = Object.freeze(['fast', 'slow']);

export const ID_KINDS = Object.freeze([
  'session',
  'message',
  'turn',
  'thread',
  'item',
  'task',
  'call',
  'request',
  'toolUse',
]);

const ID_FIELD_KEYS = Object.freeze([
  ...ID_KINDS,
  'agentThread',
  'parentThread',
]);

export const ID_PREFIX = Object.freeze({
  session: 's',
  message: 'm',
  turn: 't',
  thread: 'h',
  item: 'i',
  task: 'k',
  call: 'c',
  request: 'r',
  toolUse: 'u',
});

export const CONTROL_ACTIONS = Object.freeze([
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
]);

export const EVIDENCE_EVENTS = Object.freeze([
  'admitted',
  'interrupt-sent',
  'interrupt-ack',
  'window-closed',
  'release',
]);

const EVIDENCE_ROLES = Object.freeze(['root', 'child', 'sibling']);

export const FIELD_KEYS = Object.freeze([
  'originKind',
  'terminalReason',
  'stopReason',
  'resultSubtype',
  'isError',
  'resultIndex',
  'sessionState',
  'commandState',
  'taskType',
  'taskStatus',
  'isBackgrounded',
  'ambient',
  'workflowName',
  'workflowPhase',
  'backgroundMembersSet',
  'threadStatus',
  'subagentKind',
  'activeFlagsSet',
  'turnStatus',
  'errorClass',
  'willRetry',
  'serverRequestResolution',
  'segment',
]);

export const CLAUDE_SDK_TYPES = Object.freeze([
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

export const CLAUDE_SYSTEM_SUBTYPES = Object.freeze([
  'api_retry',
  'background_tasks_changed',
  'commands_changed',
  'compact_boundary',
  'control_request_progress',
  'elicitation_complete',
  'files_persisted',
  'hook_progress',
  'hook_response',
  'hook_started',
  'informational',
  'init',
  'local_command_output',
  'memory_recall',
  'mirror_error',
  'model_refusal_fallback',
  'model_refusal_no_fallback',
  'notification',
  'permission_denied',
  'plugin_install',
  'session_state_changed',
  'status',
  'task_notification',
  'task_progress',
  'task_started',
  'task_updated',
  'thinking_tokens',
  'worker_shutting_down',
]);

export const CLAUDE_RESULT_SUBTYPES = Object.freeze([
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_max_turns',
  'success',
]);

/** Finite statuses exposed by Agent and Workflow tool result declarations. */
export const CLAUDE_TOOL_RESULT_STATUSES = Object.freeze([
  'async_launched',
  'completed',
  'remote_launched',
]);

export const CLAUDE_ORIGIN_KINDS = Object.freeze([
  'auto-continuation',
  'channel',
  'coordinator',
  'human',
  'observer',
  'observer-activity',
  'peer',
  'task-notification',
  'unclassified',
]);

export const CLAUDE_TERMINAL_REASONS = Object.freeze([
  'aborted_streaming',
  'aborted_tools',
  'api_error',
  'background_requested',
  'blocking_limit',
  'budget_exhausted',
  'completed',
  'hook_stopped',
  'image_error',
  'malformed_tool_use_exhausted',
  'max_turns',
  'model_error',
  'prompt_too_long',
  'rapid_refill_breaker',
  'stop_hook_prevented',
  'structured_output_retry_exhausted',
  'tool_deferred',
  'tool_deferred_unavailable',
  'turn_setup_failed',
]);

export const CLAUDE_STOP_REASONS = Object.freeze([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
]);

export const CLAUDE_SESSION_STATES = Object.freeze([
  'idle',
  'requires_action',
  'running',
]);

export const CLAUDE_TASK_STATUSES = Object.freeze([
  'completed',
  'failed',
  'killed',
  'paused',
  'pending',
  'running',
  'stopped',
]);

// Installed SDK union omits command_lifecycle; these four states are pinned
// by phase22 protocol handling and real staged-CLI observations. Unknown fails.
export const CLAUDE_COMMAND_STATES = Object.freeze([
  'queued',
  'started',
  'completed',
  'cancelled',
]);

export const CLAUDE_SDK_STATUSES = Object.freeze(['compacting', 'requesting']);

export const CLAUDE_RATE_LIMIT_STATUSES = Object.freeze([
  'allowed',
  'allowed_warning',
  'rejected',
]);

export const CLAUDE_STREAM_EVENT_TYPES = Object.freeze([
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_start',
  'message_delta',
  'message_stop',
  'ping',
]);

export const CLAUDE_BLOCK_TYPES = Object.freeze([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
]);

export const CLAUDE_STREAM_DELTA_TYPES = Object.freeze([
  'citations_delta',
  'compaction_delta',
  'input_json_delta',
  'signature_delta',
  'thinking_delta',
  'text_delta',
]);

export const CODEX_NOTIFICATION_METHODS = Object.freeze([
  'account/gatewayOAuth/changed',
  'account/login/completed',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'autoApprovalReview/strictReviewRequired',
  'command/exec/outputDelta',
  'configWarning',
  'deprecationNotice',
  'error',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fs/changed',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'guardianWarning',
  'hook/completed',
  'hook/started',
  'item/agentMessage/delta',
  'item/autoApprovalReview/completed',
  'item/autoApprovalReview/started',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/completed',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/started',
  'mcpServer/event/stream/notification',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'model/rerouted',
  'model/safetyBuffering/updated',
  'model/verification',
  'modelProvider/authRecoveryCompleted',
  'modelProvider/authRecoveryStarted',
  'process/exited',
  'process/outputDelta',
  'project/changed',
  'rawResponse/completed',
  'rawResponseItem/completed',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'skills/changed',
  'thread/archived',
  'thread/attachment/updated',
  'thread/closed',
  'thread/compacted',
  'thread/deleted',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/goal/cleared',
  'thread/goal/updated',
  'thread/name/updated',
  'thread/project/updated',
  'thread/queue/changed',
  'thread/realtime/closed',
  'thread/realtime/error',
  'thread/realtime/item/completed',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/itemAdded',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/started',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/reverted',
  'thread/settings/updated',
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'thread/unarchived',
  'turn/completed',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'turn/plan/updated',
  'turn/started',
  'warning',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
]);

export const CODEX_REQUEST_METHODS = Object.freeze([
  'account/chatgptAuthTokens/refresh',
  'applyPatchApproval',
  'attestation/generate',
  'currentTime/read',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/call',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

// Methods initiated by the client are observed as responses on the wire. This
// finite set mirrors the generated app-server ClientRequest declaration.
export const CODEX_CLIENT_REQUEST_METHODS = Object.freeze([
  'account/bedrock/discover',
  'account/bedrock/setup',
  'account/gatewayOAuth/cancel',
  'account/gatewayOAuth/login',
  'account/gatewayOAuth/read',
  'account/login/cancel',
  'account/login/start',
  'account/logout',
  'account/rateLimitResetCredit/consume',
  'account/rateLimits/read',
  'account/read',
  'account/sendAddCreditsNudgeEmail',
  'account/usage/read',
  'account/workspaceMessages/read',
  'app/installed',
  'app/list',
  'app/read',
  'collaborationMode/list',
  'command/exec',
  'command/exec/resize',
  'command/exec/terminate',
  'command/exec/write',
  'config/batchWrite',
  'config/mcpServer/reload',
  'config/read',
  'config/value/write',
  'configRequirements/read',
  'environment/add',
  'environment/info',
  'environment/status',
  'experimentalFeature/enablement/set',
  'experimentalFeature/list',
  'externalAgentConfig/detect',
  'externalAgentConfig/import',
  'externalAgentConfig/import/readHistories',
  'externalAgentConfig/import/recordHistory',
  'feedback/upload',
  'fs/copy',
  'fs/createDirectory',
  'fs/getMetadata',
  'fs/readDirectory',
  'fs/readFile',
  'fs/remove',
  'fs/unwatch',
  'fs/watch',
  'fs/writeFile',
  'fuzzyFileSearch',
  'fuzzyFileSearch/sessionStart',
  'fuzzyFileSearch/sessionStop',
  'fuzzyFileSearch/sessionUpdate',
  'getAuthStatus',
  'getConversationSummary',
  'gitDiffToRemote',
  'hooks/list',
  'initialize',
  'marketplace/add',
  'marketplace/remove',
  'marketplace/upgrade',
  'mcpServer/event/stream/start',
  'mcpServer/event/stream/stop',
  'mcpServer/oauth/login',
  'mcpServer/resource/read',
  'mcpServer/tool/call',
  'mcpServerStatus/list',
  'memory/reset',
  'memory/status',
  'mock/experimentalMethod',
  'model/list',
  'modelProvider/capabilities/read',
  'permissionProfile/list',
  'plugin/install',
  'plugin/installed',
  'plugin/list',
  'plugin/read',
  'plugin/reconcile',
  'plugin/search',
  'plugin/share/checkout',
  'plugin/share/delete',
  'plugin/share/list',
  'plugin/share/save',
  'plugin/share/updateTargets',
  'plugin/skill/read',
  'plugin/uninstall',
  'process/kill',
  'process/resizePty',
  'process/spawn',
  'process/writeStdin',
  'project/create',
  'project/delete',
  'project/import',
  'project/list',
  'project/move',
  'project/read',
  'project/update',
  'remoteControl/client/list',
  'remoteControl/client/revoke',
  'remoteControl/disable',
  'remoteControl/enable',
  'remoteControl/pairing/start',
  'remoteControl/pairing/status',
  'remoteControl/status/read',
  'review/start',
  'rollout/compress',
  'server/diagnostics',
  'skills/config/write',
  'skills/extraRoots/set',
  'skills/list',
  'thread/approveGuardianDeniedAction',
  'thread/archive',
  'thread/attachment/add',
  'thread/attachment/list',
  'thread/attachment/remove',
  'thread/backgroundTerminals/clean',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/compact/start',
  'thread/decrement_elicitation',
  'thread/delete',
  'thread/fork',
  'thread/goal/clear',
  'thread/goal/get',
  'thread/goal/set',
  'thread/increment_elicitation',
  'thread/inject_items',
  'thread/items/list',
  'thread/list',
  'thread/loaded/list',
  'thread/memoryMode/set',
  'thread/metadata/update',
  'thread/name/set',
  'thread/queue/add',
  'thread/queue/delete',
  'thread/queue/list',
  'thread/queue/reorder',
  'thread/queue/start',
  'thread/queue/update',
  'thread/read',
  'thread/realtime/appendAudio',
  'thread/realtime/appendSpeech',
  'thread/realtime/appendText',
  'thread/realtime/listVoices',
  'thread/realtime/start',
  'thread/realtime/stop',
  'thread/resume',
  'thread/revert',
  'thread/search',
  'thread/searchOccurrences',
  'thread/section/move',
  'thread/settings/update',
  'thread/shellCommand',
  'thread/start',
  'thread/timeline/list',
  'thread/turns/list',
  'thread/unarchive',
  'thread/unsubscribe',
  'threadSection/create',
  'threadSection/delete',
  'threadSection/list',
  'threadSection/update',
  'turn/interrupt',
  'turn/settings/update',
  'turn/start',
  'turn/steer',
  'userVerification/cancel',
  'userVerification/delete',
  'userVerification/enroll',
  'userVerification/status',
  'userVerification/verify',
  'windowsSandbox/readiness',
  'windowsSandbox/setupStart',
]);

export const CODEX_RESPONSE_METHODS = Object.freeze([
  ...CODEX_CLIENT_REQUEST_METHODS,
  ...CODEX_REQUEST_METHODS,
]);

export const CODEX_ITEM_TYPES = Object.freeze([
  'agentMessage',
  'collabAgentToolCall',
  'commandExecution',
  'contextCompaction',
  'dynamicToolCall',
  'enteredReviewMode',
  'exitedReviewMode',
  'fileChange',
  'functionCallOutput',
  'hookPrompt',
  'imageGeneration',
  'imageView',
  'mcpToolCall',
  'plan',
  'reasoning',
  'sleep',
  'subAgentActivity',
  'userMessage',
  'webSearch',
]);

/** Mirrors generated/v2/SubAgentActivityKind.ts. */
export const CODEX_SUBAGENT_ACTIVITY_KINDS = Object.freeze([
  'started',
  'interacted',
  'interrupted',
  'completed',
]);

export const CODEX_THREAD_STATUSES = Object.freeze([
  'active',
  'idle',
  'notLoaded',
  'systemError',
]);

export const CODEX_ACTIVE_FLAGS = Object.freeze([
  'waitingOnApproval',
  'waitingOnUserInput',
]);

export const CODEX_TURN_STATUSES = Object.freeze([
  'completed',
  'failed',
  'inProgress',
  'interrupted',
]);

export const CODEX_ITEM_STATUSES = Object.freeze([
  'completed',
  'declined',
  'failed',
  'inProgress',
  'interrupted',
]);

/** Status vocabularies are scoped by ThreadItem type in the generated API. */
export const CODEX_ITEM_STATUS_BY_TYPE = Object.freeze({
  agentMessage: Object.freeze(['inProgress', 'completed']),
  collabAgentToolCall: Object.freeze([
    'inProgress',
    'completed',
    'failed',
    'interrupted',
  ]),
  commandExecution: Object.freeze([
    'inProgress',
    'completed',
    'failed',
    'declined',
  ]),
  dynamicToolCall: Object.freeze(['inProgress', 'completed', 'failed']),
  fileChange: Object.freeze(['inProgress', 'completed', 'failed', 'declined']),
  mcpToolCall: Object.freeze(['inProgress', 'completed', 'failed']),
});

export const ERROR_CLASSES = Object.freeze([
  'abort',
  'authentication',
  'billing',
  'other',
  'rate-limit',
  'request',
  'server',
  'timeout',
]);

export const CLAUDE_TASK_TYPES = Object.freeze([
  'agent',
  'auto_mode_scan',
  'background',
  'command',
  'dream',
  'in_process_teammate',
  'local_agent',
  'local_bash',
  'local_js',
  'local_workflow',
  'mcp_task',
  'monitor_mcp',
  'monitor_ws',
  'prompt',
  'remote_agent',
  'workflow',
]);

const TEMPLATE_DEFINITIONS = {
  'claude.sdk-message': { provider: 'claude', dispatch: 'type-shape' },
  'claude.stream-event': { provider: 'claude', dispatch: 'type-shape' },
  'claude.assistant.blocks': { provider: 'claude', dispatch: 'type-shape' },
  'claude.assistant.text': { provider: 'claude', dispatch: 'type-shape' },
  'claude.assistant.thinking': { provider: 'claude', dispatch: 'type-shape' },
  'claude.assistant.tool_result': {
    provider: 'claude',
    dispatch: 'type-shape',
  },
  'claude.assistant.tool_use': { provider: 'claude', dispatch: 'type-shape' },
  'claude.result': { provider: 'claude', dispatch: 'type-shape' },
  'claude.system.task_notification': {
    provider: 'claude',
    dispatch: 'type-shape',
  },
  'claude.system.task_progress': { provider: 'claude', dispatch: 'type-shape' },
  'claude.system.task_started': { provider: 'claude', dispatch: 'type-shape' },
  'claude.system.task_updated': { provider: 'claude', dispatch: 'type-shape' },
  'codex.item.collabAgentToolCall.completed': {
    provider: 'codex',
    dispatch: 'type-shape',
  },
  'codex.item.commandExecution.completed': {
    provider: 'codex',
    dispatch: 'type-shape',
  },
  'codex.item.dynamicToolCall.completed': {
    provider: 'codex',
    dispatch: 'type-shape',
  },
  'codex.item.fileChange.completed': {
    provider: 'codex',
    dispatch: 'type-shape',
  },
  'codex.item.mcpToolCall.completed': {
    provider: 'codex',
    dispatch: 'type-shape',
  },
  'codex.notification': { provider: 'codex', dispatch: 'type-shape' },
  'codex.request': { provider: 'codex', dispatch: 'type-shape' },
  'codex.response': { provider: 'codex', dispatch: 'type-shape' },
};

export const TEMPLATE_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(TEMPLATE_DEFINITIONS).map(([name, definition]) => [
      name,
      Object.freeze({ ...definition }),
    ]),
  ),
);

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'scenario',
  'provider',
  'tier',
  'profile',
  'provenance',
  'semantics',
  'steps',
];
const PROVENANCE_KEYS = ['binaryVersion', 'sdkVersion'];
const FRAME_KEYS = [
  'kind',
  'lane',
  'type',
  'shape',
  'ids',
  'consumed',
  'fields',
  'template',
];
const CONTROL_KEYS = ['kind', 'action', 'ids', 'barrier'];
const EVIDENCE_IDS_KEYS = ['thread', 'turn'];

const FIELD_ENUMS = {
  originKind: CLAUDE_ORIGIN_KINDS,
  terminalReason: CLAUDE_TERMINAL_REASONS,
  stopReason: CLAUDE_STOP_REASONS,
  resultSubtype: [...CLAUDE_RESULT_SUBTYPES, ...CLAUDE_TOOL_RESULT_STATUSES],
  sessionState: CLAUDE_SESSION_STATES,
  commandState: CLAUDE_COMMAND_STATES,
  taskStatus: CLAUDE_TASK_STATUSES,
  threadStatus: CODEX_THREAD_STATUSES,
  subagentKind: CODEX_SUBAGENT_ACTIVITY_KINDS,
  activeFlagsSet: CODEX_ACTIVE_FLAGS,
  turnStatus: CODEX_TURN_STATUSES,
  serverRequestResolution: ['error', 'resolved', 'result'],
  errorClass: ERROR_CLASSES,
  taskType: CLAUDE_TASK_TYPES,
};

const SAFE_SYMBOL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._/-]{0,95}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function fail(path, reason) {
  throw new TypeError(`Invalid lifecycle fixture at ${path}: ${reason}`);
}

function safeDiscriminator(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,80}$/.test(value)
    ? `"${value}"`
    : '<invalid>';
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isPlainRecord(value)) fail(path, 'expected an object');
}

function assertKeys(value, required, optional, path) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown property');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      fail(`${path}.${key}`, 'required property is missing');
  }
}

function assertSafeToken(value, path, pattern = SAFE_LABEL) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(path, 'expected a bounded safe symbol');
  }
}

function assertStringArray(value, path, pattern = SAFE_LABEL) {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  for (let index = 0; index < value.length; index += 1) {
    assertSafeToken(value[index], `${path}[${index}]`, pattern);
  }
}

function assertIdAlias(kind, value, path) {
  const prefix = ID_PREFIX[kind];
  if (
    typeof value !== 'string' ||
    !new RegExp(`^${prefix}[1-9][0-9]*$`).test(value)
  ) {
    fail(path, `expected a stable ${kind} alias`);
  }
}

function assertFieldScalar(key, value, path) {
  if (value === null) return;
  if (FIELD_ENUMS[key]) {
    if (typeof value !== 'string' || !FIELD_ENUMS[key].includes(value)) {
      fail(path, `unknown status or enum value ${safeDiscriminator(value)}`);
    }
    return;
  }
  switch (key) {
    case 'isError':
    case 'isBackgrounded':
    case 'ambient':
    case 'willRetry':
      if (typeof value !== 'boolean') fail(path, 'expected a boolean');
      return;
    case 'resultIndex':
      if (!Number.isSafeInteger(value) || value < 0) {
        fail(path, 'expected a non-negative integer');
      }
      return;
    case 'taskType':
      if (!CLAUDE_TASK_TYPES.includes(value)) fail(path, 'unknown task type');
      return;
    case 'workflowPhase':
      if (typeof value !== 'string' || !/^phase[1-9][0-9]*$/.test(value)) {
        fail(path, 'expected a scenario-owned workflow phase symbol');
      }
      return;
    case 'workflowName':
      if (typeof value !== 'string' || !/^workflow[1-9][0-9]*$/.test(value)) {
        fail(path, 'expected a scenario-owned workflow symbol');
      }
      return;
    case 'errorClass':
      assertSafeToken(value, path, SAFE_SYMBOL);
      return;
    case 'segment':
      if (value !== true) fail(path, 'segment is only represented by true');
      return;
    default:
      fail(path, 'field is not allowlisted');
  }
}

function isKnownClaudeType(type) {
  const parts = type.slice('sdk:'.length).split(':');
  if (parts.length === 1)
    return (
      CLAUDE_SDK_TYPES.includes(parts[0]) &&
      !['system', 'result'].includes(parts[0])
    );
  if (parts.length === 2 && parts[0] === 'system') {
    return CLAUDE_SYSTEM_SUBTYPES.includes(parts[1]);
  }
  if (parts.length === 2 && parts[0] === 'result') {
    return CLAUDE_RESULT_SUBTYPES.includes(parts[1]);
  }
  return false;
}

function isKnownCodexType(type) {
  const separator = type.indexOf(':');
  if (separator < 0) return false;
  const kind = type.slice(0, separator);
  const method = type.slice(separator + 1);
  if (!method) return false;
  if (kind === 'notification')
    return CODEX_NOTIFICATION_METHODS.includes(method);
  if (kind === 'request') return CODEX_REQUEST_METHODS.includes(method);
  if (kind === 'response') return CODEX_RESPONSE_METHODS.includes(method);
  return false;
}

function validateType(provider, type, path) {
  if (typeof type !== 'string') fail(path, 'expected a frame type');
  const isKnown =
    provider === 'claude' ? isKnownClaudeType(type) : isKnownCodexType(type);
  if (!isKnown)
    fail(path, `unknown ${provider} event type ${safeDiscriminator(type)}`);
}

function validateIds(value, path) {
  assertRecord(value, path);
  for (const key of Object.keys(value)) {
    if (key === 'agentThread' || key === 'parentThread') {
      assertIdAlias('thread', value[key], `${path}.${key}`);
      continue;
    }
    if (!ID_KINDS.includes(key))
      fail(`${path}.${key}`, 'unknown identifier kind');
    assertIdAlias(key, value[key], `${path}.${key}`);
  }
}

function validateFields(value, path) {
  assertRecord(value, path);
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!FIELD_KEYS.includes(key))
      fail(`${path}.${key}`, 'field is not allowlisted');
    if (key === 'subagentKind') {
      assertFieldScalar(key, fieldValue, `${path}.${key}`);
      continue;
    }
    if (fieldValue === null) continue;

    if (key.endsWith('Set')) {
      if (!Array.isArray(fieldValue))
        fail(`${path}.${key}`, 'expected a set array');
      const values = fieldValue;
      const pattern =
        key === 'backgroundMembersSet' ? /^k[1-9][0-9]*$/ : SAFE_SYMBOL;
      for (let index = 0; index < values.length; index += 1) {
        assertSafeToken(values[index], `${path}.${key}[${index}]`, pattern);
        if (values.indexOf(values[index]) !== index)
          fail(`${path}.${key}`, 'set values must be unique');
        if (
          key === 'activeFlagsSet' &&
          !CODEX_ACTIVE_FLAGS.includes(values[index])
        ) {
          fail(`${path}.${key}[${index}]`, 'unknown active flag');
        }
      }
      continue;
    }
    if (Array.isArray(fieldValue)) {
      for (let index = 0; index < fieldValue.length; index += 1) {
        assertFieldScalar(key, fieldValue[index], `${path}.${key}[${index}]`);
      }
      continue;
    }
    assertFieldScalar(key, fieldValue, `${path}.${key}`);
  }
}

function validateFrame(step, provider, path) {
  assertRecord(step, path);
  assertKeys(
    step,
    ['kind', 'lane', 'type', 'template'],
    ['shape', 'ids', 'consumed', 'fields'],
    path,
  );
  if (step.kind !== 'frame') fail(`${path}.kind`, 'expected frame');

  if (step.lane !== 'root') {
    const childLane =
      typeof step.lane === 'string'
        ? /^child:([a-z])[1-9][0-9]*$/.exec(step.lane)
        : null;
    const knownAliasPrefixes = new Set(Object.values(ID_PREFIX));
    if (!childLane || !knownAliasPrefixes.has(childLane[1])) {
      fail(`${path}.lane`, 'expected root or a stable child alias');
    }
  }
  validateType(provider, step.type, `${path}.type`);

  if (Object.hasOwn(step, 'shape')) {
    assertStringArray(step.shape, `${path}.shape`, SAFE_SYMBOL);
    if (step.shape.length === 0)
      fail(`${path}.shape`, 'empty shape must be omitted');
    if (provider === 'claude') {
      const allowed = new Set([
        ...CLAUDE_BLOCK_TYPES,
        ...CLAUDE_STREAM_EVENT_TYPES,
        ...CLAUDE_STREAM_DELTA_TYPES,
      ]);
      if (step.shape.some((part) => !allowed.has(part))) {
        const unknown = step.shape.find((part) => !allowed.has(part));
        fail(
          `${path}.shape`,
          `unknown Claude block or stream-event kind ${safeDiscriminator(unknown)}`,
        );
      }
    } else {
      const [itemType, itemStatus] = step.shape;
      if (
        step.shape.length > 2 ||
        !CODEX_ITEM_TYPES.includes(itemType) ||
        (itemStatus !== undefined &&
          !CODEX_ITEM_STATUS_BY_TYPE[itemType]?.includes(itemStatus))
      ) {
        const unknown = !CODEX_ITEM_TYPES.includes(itemType)
          ? itemType
          : itemStatus;
        fail(
          `${path}.shape`,
          `unknown Codex item type or status ${safeDiscriminator(unknown)}`,
        );
      }
    }
  }
  if (Object.hasOwn(step, 'ids')) validateIds(step.ids, `${path}.ids`);
  if (Object.hasOwn(step, 'consumed')) {
    assertStringArray(step.consumed, `${path}.consumed`, /^m[1-9][0-9]*$/);
  }
  if (Object.hasOwn(step, 'fields')) {
    validateFields(step.fields, `${path}.fields`);
    const subtypes =
      step.fields.resultSubtype === undefined
        ? []
        : Array.isArray(step.fields.resultSubtype)
          ? step.fields.resultSubtype
          : [step.fields.resultSubtype];
    const toolResultSubtype = subtypes.find((subtype) =>
      CLAUDE_TOOL_RESULT_STATUSES.includes(subtype),
    );
    if (
      toolResultSubtype !== undefined &&
      (provider !== 'claude' ||
        step.type !== 'sdk:user' ||
        !step.shape?.includes('tool_result'))
    ) {
      fail(
        `${path}.fields.resultSubtype`,
        'tool-result status is only valid on a Claude user tool_result frame',
      );
    }
    if (
      step.fields.subagentKind !== undefined &&
      (provider !== 'codex' ||
        !['notification:item/started', 'notification:item/completed'].includes(
          step.type,
        ) ||
        step.shape?.[0] !== 'subAgentActivity')
    ) {
      fail(
        `${path}.fields.subagentKind`,
        'subagent kind is only valid on a Codex subAgentActivity item notification',
      );
    }
  }
  if (
    step.ids?.agentThread !== undefined &&
    (provider !== 'codex' ||
      !['notification:item/started', 'notification:item/completed'].includes(
        step.type,
      ) ||
      step.shape?.[0] !== 'subAgentActivity')
  ) {
    fail(
      `${path}.ids.agentThread`,
      'agent thread is only valid on a Codex subAgentActivity item notification',
    );
  }
  if (
    step.ids?.parentThread !== undefined &&
    (provider !== 'codex' ||
      ![
        'notification:thread/started',
        'notification:thread/status/changed',
        'response:thread/start',
      ].includes(step.type) ||
      step.ids?.thread === undefined ||
      step.ids.parentThread === step.ids.thread)
  ) {
    fail(
      `${path}.ids.parentThread`,
      'parent thread is only valid on a Codex thread frame with a distinct thread id',
    );
  }

  if (
    typeof step.template !== 'string' ||
    !Object.hasOwn(TEMPLATE_REGISTRY, step.template)
  ) {
    fail(`${path}.template`, 'unknown synthetic payload template');
  }
  if (TEMPLATE_REGISTRY[step.template].provider !== provider) {
    fail(
      `${path}.template`,
      'template provider does not match fixture provider',
    );
  }
}

function validateControl(step, path) {
  assertRecord(step, path);
  assertKeys(step, ['kind', 'action'], ['ids', 'barrier'], path);
  if (step.kind !== 'control') fail(`${path}.kind`, 'expected control');
  if (!CONTROL_ACTIONS.includes(step.action))
    fail(`${path}.action`, 'unknown control action');
  if (Object.hasOwn(step, 'ids')) validateIds(step.ids, `${path}.ids`);
  if (Object.hasOwn(step, 'barrier'))
    assertSafeToken(step.barrier, `${path}.barrier`);
}

function validateEvidence(step, provider, path) {
  assertRecord(step, path);
  if (step.kind !== 'evidence') fail(`${path}.kind`, 'expected evidence');
  if (provider !== 'codex') fail(`${path}.kind`, 'D10 evidence is Codex-only');
  if (!EVIDENCE_EVENTS.includes(step.event))
    fail(`${path}.event`, 'unknown D10 evidence event');

  const fieldsByEvent = {
    admitted: ['role', 'ids', 'barrier', 'stepId'],
    'interrupt-sent': ['role', 'ids'],
    'interrupt-ack': ['role', 'ids', 'outcome'],
    'window-closed': ['outcome'],
    release: ['role', 'ids', 'barrier'],
  };
  const required = ['kind', 'event', ...fieldsByEvent[step.event]];
  assertKeys(step, required, [], path);

  if (step.event === 'window-closed') {
    if (!['observed', 'inconclusive'].includes(step.outcome))
      fail(`${path}.outcome`, 'expected observed or inconclusive');
    return;
  }

  if (!EVIDENCE_ROLES.includes(step.role))
    fail(`${path}.role`, 'unknown D10 role');
  if (step.event === 'interrupt-sent' || step.event === 'interrupt-ack') {
    if (!['root', 'child'].includes(step.role))
      fail(`${path}.role`, 'interrupt evidence cannot target a sibling');
  }

  assertRecord(step.ids, `${path}.ids`);
  assertKeys(step.ids, EVIDENCE_IDS_KEYS, [], `${path}.ids`);
  validateIds(step.ids, `${path}.ids`);

  if (step.event === 'admitted') {
    const expectedBarrier = `d10-${step.role}-held`;
    const expectedStepId = `d10-${step.role}-held-step`;
    if (step.barrier !== expectedBarrier)
      fail(`${path}.barrier`, 'does not match the D10 role');
    if (step.stepId !== expectedStepId)
      fail(`${path}.stepId`, 'does not match the D10 role');
  } else if (step.event === 'release') {
    if (step.barrier !== `d10-${step.role}-held`)
      fail(`${path}.barrier`, 'does not match the D10 role');
  }

  if (
    step.event === 'interrupt-ack' &&
    !['success', 'error'].includes(step.outcome)
  )
    fail(`${path}.outcome`, 'expected success or error');
}

function validateStep(step, provider, path, depth = 0) {
  if (depth > 16) fail(path, 'group nesting is too deep');
  assertRecord(step, path);
  if (step.kind === 'frame') return validateFrame(step, provider, path);
  if (step.kind === 'control') return validateControl(step, path);
  if (step.kind === 'evidence') return validateEvidence(step, provider, path);
  if (step.kind === 'group') {
    assertKeys(step, ['kind', 'lanes'], [], path);
    if (!Array.isArray(step.lanes) || step.lanes.length < 2) {
      fail(`${path}.lanes`, 'a concurrency group requires at least two lanes');
    }
    for (let laneIndex = 0; laneIndex < step.lanes.length; laneIndex += 1) {
      const lane = step.lanes[laneIndex];
      if (!Array.isArray(lane) || lane.length === 0) {
        fail(
          `${path}.lanes[${laneIndex}]`,
          'expected a non-empty ordered lane',
        );
      }
      for (let stepIndex = 0; stepIndex < lane.length; stepIndex += 1) {
        validateStep(
          lane[stepIndex],
          provider,
          `${path}.lanes[${laneIndex}][${stepIndex}]`,
          depth + 1,
        );
      }
    }
    return;
  }
  fail(`${path}.kind`, 'unknown step kind');
}

/** Validate a C2 lifecycle fixture, returning the original object on success. */
export function validateFixture(fixture) {
  assertRecord(fixture, 'fixture');
  assertKeys(fixture, TOP_LEVEL_KEYS, [], 'fixture');
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    fail('fixture.schemaVersion', `expected ${FIXTURE_SCHEMA_VERSION}`);
  }
  assertSafeToken(fixture.scenario, 'fixture.scenario');
  if (!PROVIDERS.includes(fixture.provider))
    fail('fixture.provider', 'expected claude or codex');
  if (!TIERS.includes(fixture.tier))
    fail('fixture.tier', 'expected fast or slow');
  assertSafeToken(fixture.profile, 'fixture.profile');

  assertRecord(fixture.provenance, 'fixture.provenance');
  assertKeys(
    fixture.provenance,
    ['binaryVersion'],
    ['sdkVersion'],
    'fixture.provenance',
  );
  assertSafeToken(
    fixture.provenance.binaryVersion,
    'fixture.provenance.binaryVersion',
    SAFE_VERSION,
  );
  if (Object.hasOwn(fixture.provenance, 'sdkVersion')) {
    assertSafeToken(
      fixture.provenance.sdkVersion,
      'fixture.provenance.sdkVersion',
      SAFE_VERSION,
    );
  }

  assertStringArray(fixture.semantics, 'fixture.semantics');
  if (!Array.isArray(fixture.steps)) fail('fixture.steps', 'expected an array');
  for (let index = 0; index < fixture.steps.length; index += 1) {
    validateStep(
      fixture.steps[index],
      fixture.provider,
      `fixture.steps[${index}]`,
    );
  }
  return fixture;
}

function d10Fail(fixture, message) {
  throw new Error(`${fixture.scenario}: ${message}`);
}

function isFrame(step, type, lane, ids) {
  return (
    step.kind === 'frame' &&
    step.type === type &&
    (lane === undefined || step.lane === lane) &&
    Object.entries(ids ?? {}).every(
      ([kind, value]) => step.ids?.[kind] === value,
    )
  );
}

/** Verify the ordered lifecycle evidence for the two D10 Codex scenarios. */
export function checkD10Semantics(fixture) {
  validateFixture(fixture);
  if (
    fixture.provider !== 'codex' ||
    !['interrupt-child-only', 'interrupt-root-with-held-child'].includes(
      fixture.scenario,
    )
  ) {
    d10Fail(fixture, 'unsupported D10 fixture identity');
  }
  if (fixture.steps.some((step) => step.kind === 'group'))
    d10Fail(fixture, 'D10 evidence cannot be grouped');

  const steps = fixture.steps;
  const indexed = steps.map((step, index) => ({ step, index }));
  const frames = indexed.filter(({ step }) => step.kind === 'frame');
  const evidence = indexed.filter(({ step }) => step.kind === 'evidence');
  const ofEvent = (event) =>
    evidence.filter(({ step }) => step.event === event);
  const exactIds = (step, ids) =>
    step.ids?.thread === ids.thread && step.ids?.turn === ids.turn;
  const admissions = ofEvent('admitted');
  if (admissions.length < 2 || admissions.length > 3)
    d10Fail(fixture, 'expected held root and child, with an optional sibling');

  const roleByName = new Map();
  for (const entry of admissions) {
    const { role } = entry.step;
    if (roleByName.has(role)) d10Fail(fixture, `duplicate ${role} admission`);
    roleByName.set(role, entry);
  }
  if (!roleByName.has('root')) d10Fail(fixture, 'missing held root');
  if (!roleByName.has('child')) d10Fail(fixture, 'missing held live child');
  const roles = [...roleByName.keys()];
  const threads = new Set();
  const turns = new Set();
  for (const role of roles) {
    const { step: admitted, index: admittedIndex } = roleByName.get(role);
    if (threads.has(admitted.ids.thread) || turns.has(admitted.ids.turn))
      d10Fail(
        fixture,
        'held roles must have distinct current thread and turn ids',
      );
    threads.add(admitted.ids.thread);
    turns.add(admitted.ids.turn);
    const lane = role === 'root' ? 'root' : `child:${admitted.ids.thread}`;
    const starts = frames.filter(({ step }) =>
      isFrame(step, 'notification:turn/started', lane, admitted.ids),
    );
    const start = starts.find(({ index }) => index < admittedIndex);
    if (
      starts.length !== 1 ||
      !start ||
      (start.step.fields?.turnStatus !== undefined &&
        start.step.fields.turnStatus !== 'inProgress')
    ) {
      d10Fail(
        fixture,
        `missing held live ${role} current turn/started before admission`,
      );
    }
    const priorTerminal = frames.some(
      ({ step, index }) =>
        index < admittedIndex &&
        isFrame(step, 'notification:turn/completed', lane, admitted.ids),
    );
    if (priorTerminal)
      d10Fail(fixture, `${role} turn terminated before admission`);
    if (
      frames.some(
        ({ step }) =>
          step.ids?.thread === admitted.ids.thread &&
          [
            'notification:turn/started',
            'notification:turn/completed',
            'notification:thread/status/changed',
          ].includes(step.type) &&
          step.lane !== lane,
      )
    ) {
      d10Fail(fixture, `${role} evidence is bound to the wrong lane`);
    }
    const laterStarts = frames.some(
      ({ step, index }) =>
        index > start.index &&
        index < steps.length &&
        step.type === 'notification:turn/started' &&
        step.ids?.thread === admitted.ids.thread &&
        step.ids?.turn !== admitted.ids.turn,
    );
    if (laterStarts)
      d10Fail(fixture, `${role} current turn changed after admission`);
  }

  const root = roleByName.get('root').step;
  const rootThreadStarts = frames.filter(({ step }) =>
    isFrame(step, 'response:thread/start', 'root'),
  );
  if (
    rootThreadStarts.length !== 1 ||
    rootThreadStarts[0].step.ids?.thread !== root.ids.thread ||
    rootThreadStarts[0].index >= roleByName.get('root').index
  ) {
    d10Fail(fixture, 'root role does not match the root thread/start response');
  }
  const rootTurnStarts = frames.filter(({ step }) =>
    isFrame(step, 'response:turn/start', 'root'),
  );
  if (
    rootTurnStarts.length !== 1 ||
    rootTurnStarts[0].step.ids?.turn !== root.ids.turn ||
    rootTurnStarts[0].index >= roleByName.get('root').index ||
    rootTurnStarts[0].index <= rootThreadStarts[0].index
  ) {
    d10Fail(
      fixture,
      'root role does not match the current root turn/start response',
    );
  }

  const child = roleByName.get('child').step;
  const childAdmissionIndex = roleByName.get('child').index;
  const rootActivitySpawn = frames.some(
    ({ step, index }) =>
      index < childAdmissionIndex &&
      step.lane === 'root' &&
      step.type === 'notification:item/started' &&
      step.shape?.[0] === 'subAgentActivity' &&
      step.fields?.subagentKind === 'started' &&
      step.ids?.thread === root.ids.thread &&
      step.ids?.turn === root.ids.turn &&
      step.ids?.agentThread === child.ids.thread,
  );
  const rootCollabSpawn = frames.some(
    ({ step, index }) =>
      index < childAdmissionIndex &&
      step.lane === 'root' &&
      step.type === 'notification:item/started' &&
      step.shape?.[0] === 'collabAgentToolCall' &&
      step.shape?.[1] === 'inProgress' &&
      step.ids?.thread === root.ids.thread &&
      step.ids?.turn === root.ids.turn,
  );
  const childParentLink = frames.some(
    ({ step, index }) =>
      index < childAdmissionIndex &&
      step.lane === `child:${child.ids.thread}` &&
      [
        'notification:thread/started',
        'notification:thread/status/changed',
      ].includes(step.type) &&
      step.ids?.thread === child.ids.thread &&
      step.ids?.parentThread === root.ids.thread,
  );
  if (!rootActivitySpawn && !(rootCollabSpawn && childParentLink))
    d10Fail(fixture, 'child is not linked to a root spawn');

  const sent = ofEvent('interrupt-sent');
  if (sent.length === 0) d10Fail(fixture, 'missing interrupt-sent');
  if (sent.length > 1) d10Fail(fixture, 'duplicate interrupt-sent target');
  const target = sent[0];
  const targetRole = target.step.role;
  const expectedTargetRole =
    fixture.scenario === 'interrupt-child-only' ? 'child' : 'root';
  if (targetRole !== expectedTargetRole)
    d10Fail(
      fixture,
      `scenario requires ${expectedTargetRole} interruption target`,
    );
  if (admissions.some(({ index }) => index >= target.index))
    d10Fail(fixture, 'every held role must be admitted before interrupt-sent');
  if (
    roles.some((role) => {
      const admitted = roleByName.get(role).step;
      const lane = role === 'root' ? 'root' : `child:${admitted.ids.thread}`;
      return frames.some(
        ({ step, index }) =>
          index < target.index &&
          isFrame(step, 'notification:turn/completed', lane, admitted.ids),
      );
    })
  ) {
    d10Fail(fixture, 'terminal before interrupt-sent');
  }
  const targetAdmission = roleByName.get(targetRole);
  if (
    !targetAdmission ||
    !exactIds(target.step, targetAdmission.step.ids) ||
    target.index <= targetAdmission.index
  ) {
    d10Fail(fixture, 'target role/thread/current turn mismatch');
  }

  const acks = ofEvent('interrupt-ack');
  if (acks.length !== 1) d10Fail(fixture, 'missing or duplicate interrupt-ack');
  const ack = acks[0];
  if (
    ack.step.role !== targetRole ||
    !exactIds(ack.step, targetAdmission.step.ids) ||
    ack.index <= target.index
  ) {
    d10Fail(
      fixture,
      'interrupt ack does not match the sent role/thread/current turn',
    );
  }
  const targetLane =
    targetRole === 'root' ? 'root' : `child:${targetAdmission.step.ids.thread}`;
  const interruptResponses = frames.filter(
    ({ step }) => step.type === 'response:turn/interrupt',
  );
  const responses = frames.filter(({ step }) =>
    isFrame(
      step,
      'response:turn/interrupt',
      targetLane,
      targetAdmission.step.ids,
    ),
  );
  if (interruptResponses.length !== 1 || responses.length !== 1)
    d10Fail(
      fixture,
      'missing actual turn/interrupt response for target thread and turn',
    );
  const response = responses[0];
  if (
    response.index <= target.index ||
    response.index >= ack.index ||
    response.step.fields?.serverRequestResolution !==
      (ack.step.outcome === 'success' ? 'result' : 'error')
  ) {
    d10Fail(
      fixture,
      'interrupt ack does not match actual turn/interrupt response',
    );
  }
  if (ack.step.outcome !== 'success')
    d10Fail(fixture, 'interrupt RPC rejected');

  const windows = ofEvent('window-closed');
  if (windows.length !== 1)
    d10Fail(fixture, 'missing or duplicate window-closed');
  const window = windows[0];
  if (window.step.outcome !== 'observed')
    d10Fail(fixture, 'window-closed was inconclusive');
  if (window.index <= ack.index)
    d10Fail(fixture, 'window-closed must follow the interrupt ack');
  if (ofEvent('release').some(({ index }) => index < window.index))
    d10Fail(fixture, 'window-closed must precede every release');

  const terminalFor = (role) => {
    const admitted = roleByName.get(role).step;
    const lane = role === 'root' ? 'root' : `child:${admitted.ids.thread}`;
    return frames.filter(({ step }) =>
      isFrame(step, 'notification:turn/completed', lane, admitted.ids),
    );
  };
  const latestThreadStatus = (
    role,
    afterIndex = -1,
    beforeIndex = Number.POSITIVE_INFINITY,
  ) => {
    const admitted = roleByName.get(role).step;
    const lane = role === 'root' ? 'root' : `child:${admitted.ids.thread}`;
    return frames
      .filter(
        ({ step, index }) =>
          index > afterIndex &&
          index < beforeIndex &&
          isFrame(step, 'notification:thread/status/changed', lane, {
            thread: admitted.ids.thread,
          }) &&
          step.fields?.threadStatus !== undefined,
      )
      .at(-1);
  };

  const targetTerminals = terminalFor(targetRole);
  if (
    targetTerminals.length !== 1 ||
    targetTerminals[0].step.fields?.turnStatus !== 'interrupted' ||
    targetTerminals[0].index <= target.index ||
    targetTerminals[0].index >= window.index
  ) {
    d10Fail(
      fixture,
      'target missing interrupted terminal before window-closed',
    );
  }
  // The pin emits idle before turn/completed; correlate both to the interrupt,
  // not to an assumed notification order between the two effects.
  if (
    latestThreadStatus(targetRole, target.index, window.index)?.step.fields
      ?.threadStatus !== 'idle'
  )
    d10Fail(fixture, 'target missing idle status before window-closed');

  for (const role of roles) {
    if (role === targetRole) continue;
    const terminalFrames = terminalFor(role);
    const beforeWindow = terminalFrames.filter(
      ({ index }) => index < window.index,
    );
    const isChildCascade =
      role === 'child' &&
      targetRole === 'root' &&
      beforeWindow.length === 1 &&
      beforeWindow[0].step.fields?.turnStatus === 'interrupted' &&
      beforeWindow[0].index > target.index;
    if (beforeWindow.length && !isChildCascade)
      d10Fail(fixture, `collateral interruption or early terminal for ${role}`);
    if (isChildCascade) {
      if (
        latestThreadStatus(role, target.index, window.index)?.step.fields
          ?.threadStatus !== 'idle'
      )
        d10Fail(
          fixture,
          'cascaded child missing idle status before window-closed',
        );
      continue;
    }

    const releases = ofEvent('release').filter(
      ({ step }) => step.role === role,
    );
    if (releases.length !== 1)
      d10Fail(fixture, `${role} survivor missing release`);
    const release = releases[0];
    const admission = roleByName.get(role).step;
    if (
      !exactIds(release.step, admission.ids) ||
      release.step.barrier !== admission.barrier ||
      release.index <= window.index
    ) {
      d10Fail(
        fixture,
        `${role} survivor release does not match its held barrier`,
      );
    }
    if (terminalFrames.some(({ index }) => index < release.index))
      d10Fail(fixture, `${role} survivor terminated before release`);
    if (
      latestThreadStatus(role, -1, window.index)?.step.fields?.threadStatus !==
      'active'
    ) {
      d10Fail(
        fixture,
        `${role} survivor missing active status during held window`,
      );
    }
    const afterRelease = terminalFrames.filter(
      ({ index }) => index > release.index,
    );
    if (
      afterRelease.length !== 1 ||
      afterRelease[0].step.fields?.turnStatus !== 'completed'
    ) {
      d10Fail(
        fixture,
        `${role} survivor did not complete normally after release`,
      );
    }
    if (
      latestThreadStatus(role, release.index)?.step.fields?.threadStatus !==
      'idle'
    )
      d10Fail(fixture, `${role} survivor missing idle status`);
  }

  const releasesByRole = new Map();
  for (const { step, index } of ofEvent('release')) {
    const admission = roleByName.get(step.role);
    if (
      !admission ||
      !exactIds(step, admission.step.ids) ||
      step.barrier !== admission.step.barrier ||
      index <= window.index
    ) {
      d10Fail(
        fixture,
        'release does not match an admitted role after window-closed',
      );
    }
    const count = (releasesByRole.get(step.role) ?? 0) + 1;
    releasesByRole.set(step.role, count);
    if (count > 1) d10Fail(fixture, `duplicate release for ${step.role}`);
  }

  return true;
}

function orderedObject(source, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

function canonicalIds(ids) {
  return orderedObject(ids, ID_FIELD_KEYS);
}

function canonicalFields(fields) {
  const ordered = orderedObject(fields, FIELD_KEYS);
  for (const [key, value] of Object.entries(ordered)) {
    if (key.endsWith('Set') && Array.isArray(value)) {
      ordered[key] = [...value].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
    } else if (Array.isArray(value)) {
      ordered[key] = [...value];
    }
  }
  return ordered;
}

function canonicalStep(step) {
  if (step.kind === 'evidence') {
    const result = { kind: 'evidence', event: step.event };
    if (Object.hasOwn(step, 'role')) result.role = step.role;
    if (Object.hasOwn(step, 'ids')) result.ids = canonicalIds(step.ids);
    if (Object.hasOwn(step, 'barrier')) result.barrier = step.barrier;
    if (Object.hasOwn(step, 'stepId')) result.stepId = step.stepId;
    if (Object.hasOwn(step, 'outcome')) result.outcome = step.outcome;
    return result;
  }
  if (step.kind === 'control') {
    const result = { kind: 'control', action: step.action };
    if (Object.hasOwn(step, 'ids')) result.ids = canonicalIds(step.ids);
    if (Object.hasOwn(step, 'barrier')) result.barrier = step.barrier;
    return result;
  }
  if (step.kind === 'group') {
    const lanes = step.lanes.map((lane) => lane.map(canonicalStep));
    lanes.sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return { kind: 'group', lanes };
  }

  const result = {
    kind: 'frame',
    lane: step.lane,
    type: step.type,
  };
  if (Object.hasOwn(step, 'shape')) result.shape = [...step.shape];
  if (Object.hasOwn(step, 'ids')) result.ids = canonicalIds(step.ids);
  if (Object.hasOwn(step, 'consumed')) result.consumed = [...step.consumed];
  if (Object.hasOwn(step, 'fields'))
    result.fields = canonicalFields(step.fields);
  result.template = step.template;
  return result;
}

/** Return a stable, ordered C2 fixture object without changing ordered arrays. */
export function canonicalFixture(fixture) {
  validateFixture(fixture);
  const result = {
    schemaVersion: fixture.schemaVersion,
    scenario: fixture.scenario,
    provider: fixture.provider,
    tier: fixture.tier,
    profile: fixture.profile,
    provenance: orderedObject(fixture.provenance, PROVENANCE_KEYS),
    semantics: [...fixture.semantics],
    steps: fixture.steps.map(canonicalStep),
  };
  return result;
}
