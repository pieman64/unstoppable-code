/**
 * Content-free lifecycle fixture helpers for the scripted Codex app-server.
 * This is a test harness adapter, not a production protocol client.
 */
import type {
  LifecycleFields,
  LifecycleFrame,
  LifecycleFrameObservation,
  LifecycleIds,
  LifecycleControl,
  LifecycleFixture,
  LifecycleStep,
} from './contracts';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';

export type CodexReplayEnvelopeKind = 'response' | 'notification' | 'request';
export type CodexReplayIdKind = keyof LifecycleIds;

export interface CodexReplayTemplate {
  kind: CodexReplayEnvelopeKind;
  method: string;
}

export type CodexReplayAliasLookup = (
  kind: CodexReplayIdKind,
  liveId: string,
) => string | undefined;

const LIFECYCLE_ID_KINDS = [
  'session',
  'message',
  'turn',
  'thread',
  'item',
  'task',
  'call',
  'request',
  'toolUse',
  'agentThread',
] as const satisfies readonly CodexReplayIdKind[];

function idNamespace(kind: CodexReplayIdKind): CodexReplayIdKind {
  return kind === 'agentThread' ? 'thread' : kind;
}

const CODEX_SERVER_REQUEST_METHODS = new Set([
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

const CODEX_ITEM_TYPES_WITH_STATUS = new Set([
  'collabAgentToolCall',
  'commandExecution',
  'dynamicToolCall',
  'fileChange',
  'mcpToolCall',
]);

/** Live JSON-RPC ids keyed by the stable aliases carried in fixture steps. */
export class CodexReplayAliases {
  private readonly liveByAlias = new Map<
    CodexReplayIdKind,
    Map<string, string>
  >();
  private readonly aliasByLive = new Map<
    CodexReplayIdKind,
    Map<string, string>
  >();

  bind(
    kind: CodexReplayIdKind,
    alias: string | undefined,
    liveId: string,
  ): void {
    if (!alias) return;
    const namespace = idNamespace(kind);
    this.mapFor(this.liveByAlias, namespace).set(alias, liveId);
    this.mapFor(this.aliasByLive, namespace).set(liveId, alias);
  }

  bindIds(ids: LifecycleIds | undefined, liveIds: LifecycleIds): void {
    if (!ids) return;
    for (const kind of LIFECYCLE_ID_KINDS) {
      const alias = ids[kind];
      const liveId = liveIds[kind];
      if (alias !== undefined && liveId !== undefined)
        this.bind(kind, alias, liveId);
    }
  }

  resolve(
    kind: CodexReplayIdKind,
    alias: string | undefined,
  ): string | undefined {
    if (alias === undefined) return undefined;
    return this.liveByAlias.get(idNamespace(kind))?.get(alias);
  }

  aliasFor(kind: CodexReplayIdKind, liveId: string): string | undefined {
    return this.aliasByLive.get(idNamespace(kind))?.get(liveId);
  }

  project: CodexReplayAliasLookup = (kind, liveId) =>
    this.aliasFor(kind, liveId);

  private mapFor(
    maps: Map<CodexReplayIdKind, Map<string, string>>,
    kind: CodexReplayIdKind,
  ): Map<string, string> {
    let map = maps.get(kind);
    if (!map) {
      map = new Map<string, string>();
      maps.set(kind, map);
    }
    return map;
  }
}

export interface CodexReplayControlMatch {
  readonly control: LifecycleControl;
  complete(liveIds: LifecycleIds): void;
}

interface ControlWaiter {
  control: LifecycleControl;
  resolve(): void;
  reject(error: Error): void;
  promise: Promise<void>;
  settled: boolean;
}

interface RequestWaiter {
  method: string;
  resolve(match: CodexReplayControlMatch): void;
  reject(error: Error): void;
}

/**
 * Correlates fixture controls with the next live Codex client request. A
 * control may be supplied before startup responses (or after the request was
 * observed); the client request waits only when the fixture declares that
 * control, so unrelated bootstrap RPCs keep flowing.
 */
export class CodexReplayControlMatcher {
  private readonly aliases: CodexReplayAliases;
  private readonly expected = new Map<string, number>();
  private readonly matched = new Map<string, number>();
  private readonly controls: ControlWaiter[] = [];
  private readonly requests: RequestWaiter[] = [];
  private closedError: Error | undefined;

  constructor(fixture: LifecycleFixture, aliases: CodexReplayAliases) {
    this.aliases = aliases;
    for (const step of fixture.steps) this.countControls(step);
  }

  acceptControl(control: LifecycleControl): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    const methods = actionMethods(control.action);
    if (methods.length === 0) return Promise.resolve();
    const waiter = this.createControlWaiter(control);
    const request = this.requests.find((candidate) =>
      methods.includes(candidate.method),
    );
    if (request) {
      this.requests.splice(this.requests.indexOf(request), 1);
      this.match(request, waiter);
    } else {
      this.controls.push(waiter);
    }
    return waiter.promise;
  }

  waitForRequest(method: string): Promise<CodexReplayControlMatch | undefined> {
    if (this.closedError) return Promise.reject(this.closedError);
    const control = this.controls.find((candidate) =>
      actionMethods(candidate.control.action).includes(method),
    );
    if (control) {
      this.controls.splice(this.controls.indexOf(control), 1);
      this.markMatched(control.control);
      return Promise.resolve(this.createMatch(control));
    }

    const actions = actionsForMethod(method);
    const needsControl = actions.some(
      (action) =>
        (this.expected.get(action) ?? 0) > (this.matched.get(action) ?? 0),
    );
    if (!needsControl) return Promise.resolve(undefined);

    return new Promise<CodexReplayControlMatch>((resolve, reject) => {
      this.requests.push({ method, resolve, reject });
    });
  }

  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.controls) waiter.reject(error);
    for (const waiter of this.requests) waiter.reject(error);
    this.controls.length = 0;
    this.requests.length = 0;
  }

  private countControls(step: LifecycleStep): void {
    if (step.kind === 'control') {
      this.expected.set(step.action, (this.expected.get(step.action) ?? 0) + 1);
      return;
    }
    if (step.kind === 'evidence' && step.event === 'interrupt-sent') {
      this.expected.set('interrupt', (this.expected.get('interrupt') ?? 0) + 1);
      return;
    }
    if (step.kind === 'group') {
      for (const lane of step.lanes) {
        for (const nested of lane) this.countControls(nested);
      }
    }
  }

  private createControlWaiter(control: LifecycleControl): ControlWaiter {
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    return {
      control,
      promise,
      resolve: (): void => resolvePromise?.(),
      reject: (error): void => rejectPromise?.(error),
      settled: false,
    };
  }

  private match(request: RequestWaiter, waiter: ControlWaiter): void {
    this.markMatched(waiter.control);
    request.resolve(this.createMatch(waiter));
  }

  private markMatched(control: LifecycleControl): void {
    this.matched.set(
      control.action,
      (this.matched.get(control.action) ?? 0) + 1,
    );
  }

  private createMatch(waiter: ControlWaiter): CodexReplayControlMatch {
    return {
      control: waiter.control,
      complete: (liveIds): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        this.aliases.bindIds(waiter.control.ids, liveIds);
        waiter.resolve();
      },
    };
  }
}

function actionMethods(action: LifecycleControl['action']): readonly string[] {
  switch (action) {
    case 'send':
    case 'start-turn':
      return ['turn/start'];
    case 'steer':
      return ['turn/steer'];
    case 'interrupt':
      return ['turn/interrupt'];
    default:
      return [];
  }
}

function actionsForMethod(method: string): LifecycleControl['action'][] {
  switch (method) {
    case 'turn/start':
      return ['send', 'start-turn'];
    case 'turn/steer':
      return ['steer'];
    case 'turn/interrupt':
      return ['interrupt'];
    default:
      return [];
  }
}

const TEMPLATE_METHODS: Readonly<Record<string, string>> = {
  'thread.start': 'thread/start',
  'thread.resume': 'thread/resume',
  'thread.read': 'thread/read',
  'thread.fork': 'thread/fork',
  'thread.started': 'thread/started',
  'thread.name.updated': 'thread/name/updated',
  'thread.tokenUsage/updated': 'thread/tokenUsage/updated',
  'turn.start': 'turn/start',
  'turn.steer': 'turn/steer',
  'turn.interrupt': 'turn/interrupt',
  'turn.started': 'turn/started',
  'turn.completed': 'turn/completed',
  'turn.plan/updated': 'turn/plan/updated',
  'item.started': 'item/started',
  'item.completed': 'item/completed',
  'item.agentMessage.delta': 'item/agentMessage/delta',
  'item.reasoning.summaryText.delta': 'item/reasoning/summaryText/delta',
  'item.reasoning.summaryPart.added': 'item/reasoning/summaryPart/added',
  'item.commandExecution.outputDelta': 'item/commandExecution/outputDelta',
  'item.fileChange.outputDelta': 'item/fileChange/outputDelta',
  'item.tool.call': 'item/tool/call',
  'item.commandExecution.requestApproval':
    'item/commandExecution/requestApproval',
  'item.fileChange.requestApproval': 'item/fileChange/requestApproval',
  'serverRequest.resolved': 'serverRequest/resolved',
  'account.rateLimits/updated': 'account/rateLimits/updated',
  'account.login/completed': 'account/login/completed',
};

/** Resolve provisional names such as `codex.response.thread.start`. */
export function resolveCodexReplayTemplate(
  frame: LifecycleFrame,
): CodexReplayTemplate {
  const frameType = /^(response|notification|request):(.+)$/.exec(frame.type);
  if (frame.template === 'codex.notification') {
    if (!frameType || frameType[1] !== 'notification') {
      throw new Error(
        `Codex notification template does not match ${frame.type}`,
      );
    }
    return { kind: 'notification', method: frameType[2] ?? '' };
  }
  if (frame.template === 'codex.response') {
    if (!frameType || frameType[1] !== 'response') {
      throw new Error(`Codex response template does not match ${frame.type}`);
    }
    return { kind: 'response', method: frameType[2] ?? '' };
  }
  if (frame.template === 'codex.request') {
    if (!frameType || frameType[1] !== 'request') {
      throw new Error(`Codex request template does not match ${frame.type}`);
    }
    return { kind: 'request', method: frameType[2] ?? '' };
  }

  const prefix = /^codex\.(response|notification|request)\.(.+)$/;
  const templateMatch = prefix.exec(frame.template);
  if (templateMatch) {
    const kind = templateMatch[1];
    const suffix = templateMatch[2];
    if (
      (kind === 'response' || kind === 'notification' || kind === 'request') &&
      suffix
    ) {
      return { kind, method: methodForTemplateSuffix(suffix) };
    }
  }

  const typedMatch = /^(response|notification|request):(.+)$/.exec(frame.type);
  if (typedMatch) {
    const kind = typedMatch[1];
    const method = typedMatch[2];
    if (
      (kind === 'response' || kind === 'notification' || kind === 'request') &&
      method
    ) {
      return { kind, method };
    }
  }

  throw new Error(
    `Unsupported Codex replay template ${frame.template} (${frame.type})`,
  );
}

/**
 * Build the smallest valid-ish response shape for a lifecycle request. The
 * scripted driver supplies its normal thread projection so the test runtime
 * sees the same required fields as the non-replay path.
 */
export function buildCodexReplayResponseResult(options: {
  method: string;
  frame: LifecycleFrame;
  threadResult?: Record<string, unknown>;
  turnId?: string;
}): Record<string, unknown> {
  const { method, frame } = options;
  let result: Record<string, unknown>;
  let fieldTarget: string | undefined;

  if (method === 'initialize') {
    result = {
      userAgent: 'scripted-codex',
      codexHome: '/tmp/scripted-codex-home',
    };
  } else if (
    method === 'thread/start' ||
    method === 'thread/resume' ||
    method === 'thread/read' ||
    method === 'thread/fork'
  ) {
    result = options.threadResult ?? {};
    fieldTarget = 'thread';
  } else if (method === 'turn/start') {
    result = {
      turn: {
        id: options.turnId ?? '',
        items: [],
        status: 'inProgress',
        error: null,
      },
    };
    fieldTarget = 'turn';
  } else {
    result = {};
  }

  applyLifecycleFields(result, frame.fields, fieldTarget);
  return result;
}

/** Build notification or server-request params from live ids and safe fields. */
export function buildCodexReplayParams(options: {
  method: string;
  frame: LifecycleFrame;
  ids: Partial<Record<CodexReplayIdKind, string>>;
  threadResult?: Record<string, unknown>;
}): Record<string, unknown> {
  const { method, frame, ids } = options;
  const params: Record<string, unknown> = {};
  if (ids.thread) params.threadId = ids.thread;
  if (ids.turn) params.turnId = ids.turn;
  if (ids.call) params.callId = ids.call;
  if (ids.task) params.taskId = ids.task;
  if (ids.toolUse) params.toolUseId = ids.toolUse;
  if (method === 'serverRequest/resolved' && ids.request) {
    params.requestId = ids.request;
  }

  let fieldTarget: string | undefined;
  if (method === 'thread/started') {
    const thread = options.threadResult
      ? nestedRecord(options.threadResult, 'thread')
      : undefined;
    if (thread) params.thread = thread;
  } else if (method === 'turn/started' || method === 'turn/completed') {
    params.turn = {
      id: ids.turn ?? '',
      items: [],
      status: method === 'turn/completed' ? 'completed' : 'inProgress',
      error: null,
    };
    fieldTarget = 'turn';
  } else if (method === 'item/agentMessage/delta') {
    params.itemId = ids.message ?? ids.item ?? '';
    params.delta = 'Synthetic lifecycle output';
  } else if (method === 'item/started' || method === 'item/completed') {
    const itemId = ids.item ?? ids.message ?? ids.call ?? ids.toolUse ?? '';
    const itemType =
      frame.shape?.[0] ??
      (ids.call
        ? 'dynamicToolCall'
        : ids.task || ids.toolUse
          ? 'collabAgentToolCall'
          : 'agentMessage');
    const item: Record<string, unknown> = {
      type: itemType,
      id: itemId,
    };
    if (CODEX_ITEM_TYPES_WITH_STATUS.has(itemType)) {
      item.status =
        frame.shape?.[1] ??
        (method === 'item/completed' ? 'completed' : 'inProgress');
    }
    if (itemType === 'agentMessage') {
      item.text = 'Synthetic lifecycle output';
      item.phase = 'final_answer';
      item.memoryCitation = null;
      item.delivery = null;
      item.questions = null;
    } else if (itemType === 'userMessage') {
      item.clientId = null;
      item.content = [
        { type: 'text', text: 'Synthetic user input', text_elements: [] },
      ];
    } else if (itemType === 'dynamicToolCall') {
      item.namespace = null;
      item.tool = CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.codexToolName;
      item.arguments = { delaySeconds: 120 };
      item.contentItems = null;
      item.success = method === 'item/completed' ? true : null;
    } else if (itemType === 'subAgentActivity') {
      const activityKind = frame.fields?.subagentKind;
      if (activityKind !== undefined) item.kind = activityKind;
      const agentThreadId = ids.agentThread ?? ids.thread;
      if (agentThreadId !== undefined) item.agentThreadId = agentThreadId;
      item.agentPath = '/tmp/scripted-codex/subagent';
    } else {
      item.tool = 'spawnAgent';
      item.receiverThreadIds = ids.task ? [ids.task] : [];
      item.agentsStates = {};
    }
    params.item = item;
    fieldTarget = 'item';
  } else if (method === 'item/tool/call') {
    params.tool = CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.codexToolName;
    params.arguments = { delaySeconds: 120 };
  } else if (method === 'item/commandExecution/requestApproval') {
    params.command = '';
    params.commandActions = [];
    params.reason = null;
  } else if (method === 'item/fileChange/requestApproval') {
    params.grantRoot = '/tmp/scripted-codex';
    params.reason = '';
  } else if (method === 'remoteControl/status/changed') {
    params.status = 'disabled';
    params.serverName = 'synthetic';
    params.installationId = 'synthetic-installation';
    params.environmentId = null;
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
  }

  if (method === 'thread/status/changed') {
    const activeFlagsSet = frame.fields?.activeFlagsSet;
    params.status = {
      type: frame.fields?.threadStatus ?? 'active',
      ...(Array.isArray(activeFlagsSet)
        ? { activeFlags: [...activeFlagsSet] }
        : activeFlagsSet === null
          ? { activeFlags: null }
          : {}),
    };
  }

  applyLifecycleFields(params, frame.fields, fieldTarget);
  return params;
}

/**
 * Project the actual envelope being written/read into the durable,
 * content-free observation contract. It never copies `LifecycleFrame` values
 * from the expected fixture.
 */
export function projectCodexReplayEnvelope(
  envelope: Record<string, unknown>,
  type: string,
  aliasFor: CodexReplayAliasLookup,
  rootThreadId?: string,
): LifecycleFrameObservation {
  const actualIds = collectCodexReplayIds(envelope);
  const ids: LifecycleIds = {};
  for (const kind of LIFECYCLE_ID_KINDS) {
    const liveId = actualIds[kind];
    if (liveId === undefined) continue;
    const alias = aliasFor(kind, liveId);
    setLifecycleId(ids, kind, alias ?? liveId);
  }

  const actualThreadId = actualIds.thread;
  const threadAlias = ids.thread;
  const lane: LifecycleFrameObservation['lane'] =
    actualThreadId && rootThreadId && actualThreadId !== rootThreadId
      ? `child:${threadAlias ?? actualThreadId}`
      : 'root';
  const shape = collectSemanticShape(envelope);
  const fields = collectSemanticFields(envelope, type);

  return {
    lane,
    type,
    ...(shape.length > 0 ? { shape } : {}),
    ...(Object.keys(ids).length > 0 ? { ids } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

/** Extract content-free identifier locations from an actual JSON-RPC frame. */
export function collectCodexReplayIds(
  envelope: Record<string, unknown>,
): LifecycleIds {
  return collectCodexIds(envelope);
}

function methodForTemplateSuffix(suffix: string): string {
  const known = TEMPLATE_METHODS[suffix];
  if (known) return known;
  return suffix.replaceAll('.', '/');
}

function nestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function applyLifecycleFields(
  target: Record<string, unknown>,
  fields: LifecycleFields | undefined,
  defaultTarget: string | undefined,
): void {
  if (!fields) return;
  for (const [key, value] of Object.entries(fields)) {
    const path =
      key.startsWith('params.') || key.startsWith('result.')
        ? key.slice(key.indexOf('.') + 1)
        : key;
    const segments = path
      .split('.')
      .filter((segment) => segment.length > 0)
      .map((segment) => (segment === 'turnStatus' ? 'status' : segment));
    if (segments.length === 0) continue;
    if (key === 'turnStatus') {
      setNestedValue(target, ['turn', 'status'], value);
      continue;
    }
    if (key === 'threadStatus') {
      const thread = nestedRecord(target, 'thread');
      if (thread) setNestedValue(target, ['thread', 'status', 'type'], value);
      else setNestedValue(target, ['status', 'type'], value);
      continue;
    }
    if (key === 'activeFlagsSet') {
      const thread = nestedRecord(target, 'thread');
      const path = thread
        ? ['thread', 'status', 'activeFlags']
        : ['status', 'activeFlags'];
      setNestedValue(target, path, value);
      continue;
    }
    if (key === 'terminalReason' && defaultTarget) {
      setNestedValue(target, [defaultTarget, 'terminalReason'], value);
      continue;
    }
    if (segments.length === 1 && defaultTarget) {
      setNestedValue(target, [defaultTarget, segments[0] ?? ''], value);
      continue;
    }
    setNestedValue(target, segments, value);
  }
}

function setNestedValue(
  target: Record<string, unknown>,
  segments: readonly string[],
  value: LifecycleFields[string],
): void {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const nested = current[segment];
    if (!isRecord(nested)) current[segment] = {};
    const next = current[segment];
    if (!isRecord(next)) return;
    current = next;
  }
  const last = segments[segments.length - 1];
  if (last) current[last] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectSemanticShape(envelope: Record<string, unknown>): string[] {
  const params = nestedRecord(envelope, 'params');
  const item = params ? nestedRecord(params, 'item') : undefined;
  if (!item) return [];
  const itemType = readString(item, 'type');
  if (!itemType) return [];
  const shape = [itemType];
  const status = readString(item, 'status');
  if (status) shape.push(status);
  return shape;
}

function collectSemanticFields(
  envelope: Record<string, unknown>,
  type: string,
): LifecycleFields {
  const fields: LifecycleFields = {};
  const params = nestedRecord(envelope, 'params');
  const result = nestedRecord(envelope, 'result');
  const payload = params ?? result ?? {};

  const item = nestedRecord(payload, 'item');
  if (item && readString(item, 'type') === 'subAgentActivity') {
    const subagentKind = readString(item, 'kind');
    if (subagentKind) fields.subagentKind = subagentKind;
  }

  const turn = nestedRecord(payload, 'turn');
  if (type.startsWith('notification:turn/')) {
    const status = payload.status ?? turn?.status;
    if (isLifecycleScalar(status)) fields.turnStatus = status;
  }

  if (type === 'notification:thread/status/changed') {
    const status = nestedRecord(payload, 'status');
    const threadStatus =
      typeof payload.status === 'string' ? payload.status : status?.type;
    if (threadStatus !== undefined) {
      if (isLifecycleScalar(threadStatus)) fields.threadStatus = threadStatus;
    }
    const rawFlags = status?.activeFlags ?? status?.active_flags;
    if (Array.isArray(rawFlags)) {
      const flags = rawFlags.filter(
        (flag): flag is string => typeof flag === 'string',
      );
      fields.activeFlagsSet = Array.from(new Set(flags)).sort();
    }
  }

  if (type === 'notification:serverRequest/resolved') {
    fields.serverRequestResolution = 'resolved';
  }
  const responseMethod = type.startsWith('response:')
    ? type.slice('response:'.length)
    : undefined;
  if (
    responseMethod &&
    (CODEX_SERVER_REQUEST_METHODS.has(responseMethod) ||
      responseMethod === 'turn/interrupt')
  ) {
    fields.serverRequestResolution =
      envelope.error !== undefined || params?.error !== undefined
        ? 'error'
        : 'result';
  }
  if (
    Object.hasOwn(envelope, 'error') ||
    params?.error !== undefined ||
    type === 'notification:error'
  ) {
    fields.errorClass = classifyCodexError(envelope);
  }

  const willRetry = payload.willRetry ?? payload.will_retry;
  if (typeof willRetry === 'boolean') fields.willRetry = willRetry;

  const method = type.slice(type.indexOf(':') + 1);
  if (
    /(?:delta|Delta)$/.test(method) ||
    method.includes('/transcript/delta') ||
    method.includes('/outputAudio/delta')
  ) {
    fields.segment = true;
  }

  return fields;
}

function isLifecycleScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function collectCodexIds(envelope: Record<string, unknown>): LifecycleIds {
  const params = nestedRecord(envelope, 'params') ?? {};
  const result = nestedRecord(envelope, 'result') ?? {};
  const item = nestedRecord(params, 'item') ?? {};
  const resultItem = nestedRecord(result, 'item') ?? {};
  const paramThread = nestedRecord(params, 'thread') ?? {};
  const paramTurn = nestedRecord(params, 'turn') ?? {};
  const ids: LifecycleIds = {};
  const resultThread = nestedRecord(result, 'thread') ?? {};
  const resultTurn = nestedRecord(result, 'turn') ?? {};
  const threadId =
    firstString(params, 'threadId', 'thread_id') ??
    stringOrNumber(paramThread.id) ??
    firstString(result, 'threadId', 'thread_id') ??
    stringOrNumber(resultThread.id);
  const turnId =
    firstString(params, 'turnId', 'turn_id') ??
    stringOrNumber(paramTurn.id) ??
    firstString(result, 'turnId', 'turn_id') ??
    stringOrNumber(resultTurn.id);
  const itemId =
    stringOrNumber(item.id) ??
    readString(params, 'itemId') ??
    stringOrNumber(resultItem.id) ??
    readString(result, 'itemId');
  const taskId =
    firstString(params, 'taskId', 'task_id') ??
    firstString(result, 'taskId', 'task_id');
  const callId =
    firstString(params, 'callId', 'call_id') ??
    readString(item, 'callId') ??
    firstString(result, 'callId', 'call_id');
  const requestId =
    firstString(params, 'requestId', 'request_id') ??
    stringOrNumber(envelope.id);
  const toolUseId =
    firstString(params, 'toolUseId', 'tool_use_id') ??
    readString(item, 'toolUseId') ??
    firstString(result, 'toolUseId', 'tool_use_id');
  const agentThreadId = firstString(item, 'agentThreadId', 'agent_thread_id');
  if (threadId !== undefined) ids.thread = threadId;
  if (turnId !== undefined) ids.turn = turnId;
  if (itemId !== undefined) ids.item = itemId;
  if (taskId !== undefined) ids.task = taskId;
  if (callId !== undefined) ids.call = callId;
  if (requestId !== undefined) ids.request = requestId;
  if (toolUseId !== undefined) ids.toolUse = toolUseId;
  if (agentThreadId !== undefined) ids.agentThread = agentThreadId;
  return ids;
}

function firstString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = stringOrNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function setLifecycleId(
  ids: LifecycleIds,
  kind: CodexReplayIdKind,
  value: string,
): void {
  switch (kind) {
    case 'session':
      ids.session = value;
      break;
    case 'message':
      ids.message = value;
      break;
    case 'turn':
      ids.turn = value;
      break;
    case 'thread':
      ids.thread = value;
      break;
    case 'item':
      ids.item = value;
      break;
    case 'task':
      ids.task = value;
      break;
    case 'call':
      ids.call = value;
      break;
    case 'request':
      ids.request = value;
      break;
    case 'toolUse':
      ids.toolUse = value;
      break;
    case 'agentThread':
      ids.agentThread = value;
      break;
  }
}

function classifyCodexError(envelope: Record<string, unknown>): string {
  const error =
    nestedRecord(envelope, 'error') ?? nestedRecord(envelope, 'params')?.error;
  const candidates =
    error && isRecord(error) ? [error.code, error.type, error.name] : [];
  const value = candidates
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .join(' ')
    .toLowerCase();
  if (/abort|cancel/.test(value)) return 'abort';
  if (/auth|unauthori|forbidden/.test(value)) return 'authentication';
  if (/billing|payment|quota/.test(value)) return 'billing';
  if (/rate.?limit|throttl/.test(value)) return 'rate-limit';
  if (/timeout|timed.?out/.test(value)) return 'timeout';
  if (/server|internal|overload/.test(value)) return 'server';
  if (/invalid|bad.?request|request/.test(value)) return 'request';
  return 'other';
}

function stringOrNumber(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}
