/**
 * Recorded real-Chromium CDP fixtures (written by `record-fixtures.ts`) and
 * their replay as page-model dependencies. Every response is replayed
 * exactly as Chromium sent it; an unrecorded request rejects.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FrameRegistry } from '../../frame-registry';
import type {
  ControlHistory,
  PageModelDeps,
  PageModelStyleRead,
  TrackerMemory,
  TrackerScope,
} from '../../model-types';
import { PIERCED_DOCUMENT_DEPTH } from '../../pierced-document';
import { decodeMeasurements, type ElementMeasurement } from './transform-truth';

export const RECORDING_VERSION = 1;
export const RECORDED_METHODS: string[] = [
  'DOM.getDocument',
  'DOMSnapshot.captureSnapshot',
  'Page.getLayoutMetrics',
  'DOM.getFrameOwner',
  'DOM.querySelectorAll',
  'DOM.getBoxModel',
  'Accessibility.getFullAXTree',
  'Runtime.evaluate',
  'DOM.getNodeForLocation',
  'DOM.describeNode',
];

export interface RecordedFrame {
  frameId: string;
  sessionId: string;
  loaderId: string;
  url: string;
  parentId?: string;
}

export interface RecordedResponse {
  method: string;
  sessionId: string;
  params: Record<string, unknown>;
  response: unknown;
}

export interface RecordedBridgeCall<T> {
  frameId: string;
  sessionId: string;
  backendNodeIds: number[];
  result: T;
}

export interface Recording {
  version: number;
  name: string;
  chromium: string;
  whitespace: boolean;
  frames: RecordedFrame[];
  responses: RecordedResponse[];
  styles: Array<
    RecordedBridgeCall<Array<PageModelStyleRead | undefined> | undefined>
  >;
  passwordHistory: Array<RecordedBridgeCall<boolean[]>>;
  /** Page-reported geometry, for fixtures that check frame placement. */
  measurements?: Record<string, ElementMeasurement>;
  /** The host's main-world context lookups (listener stage). */
  mainWorlds?: RecordedMainWorld[];
  /** The document-start trackers' answers, when recorded with trackers. */
  controlHistory?: RecordedHistoryCall[];
  /** Their "remembers any password?" summaries. */
  controlSummaries?: RecordedSummaryCall[];
}

export interface RecordedSummaryCall {
  frameId: string;
  sessionId: string;
  scope: TrackerScope;
  result: TrackerMemory;
}

export interface RecordedHistoryCall extends RecordedBridgeCall<
  ControlHistory[]
> {
  scope: TrackerScope;
}

export interface RecordedMainWorld {
  frameId: string;
  sessionId: string;
  contextId?: number;
}

export const RECORDED_DIRECTORY = path.join(__dirname, 'recorded');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableParams(params: Record<string, unknown>): string {
  return JSON.stringify(params, Object.keys(params).sort());
}

function decodeRecording(value: unknown): Recording {
  if (
    !isRecord(value) ||
    value.version !== RECORDING_VERSION ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.frames) ||
    !Array.isArray(value.responses) ||
    !Array.isArray(value.styles) ||
    !Array.isArray(value.passwordHistory)
  ) {
    throw new Error('Unsupported page-model recording.');
  }
  const frames: RecordedFrame[] = [];
  for (const frame of value.frames) {
    if (
      !isRecord(frame) ||
      typeof frame.frameId !== 'string' ||
      typeof frame.sessionId !== 'string' ||
      typeof frame.loaderId !== 'string' ||
      typeof frame.url !== 'string'
    ) {
      throw new Error('Malformed recorded frame.');
    }
    frames.push({
      frameId: frame.frameId,
      sessionId: frame.sessionId,
      loaderId: frame.loaderId,
      url: frame.url,
      ...(typeof frame.parentId === 'string'
        ? { parentId: frame.parentId }
        : {}),
    });
  }
  const responses: RecordedResponse[] = [];
  for (const entry of value.responses) {
    if (
      !isRecord(entry) ||
      typeof entry.method !== 'string' ||
      typeof entry.sessionId !== 'string' ||
      !isRecord(entry.params)
    ) {
      throw new Error('Malformed recorded response.');
    }
    responses.push({
      method: entry.method,
      sessionId: entry.sessionId,
      params: entry.params,
      response: entry.response,
    });
  }
  const bridgeIds = (entry: Record<string, unknown>): number[] => {
    const ids = entry.backendNodeIds;
    if (!Array.isArray(ids)) throw new Error('Malformed bridge call.');
    return ids.filter((id): id is number => typeof id === 'number');
  };
  const styles: Recording['styles'] = [];
  for (const entry of value.styles) {
    if (
      !isRecord(entry) ||
      typeof entry.frameId !== 'string' ||
      typeof entry.sessionId !== 'string'
    ) {
      throw new Error('Malformed recorded style read.');
    }
    const result = Array.isArray(entry.result)
      ? entry.result.map((read: unknown): PageModelStyleRead | undefined =>
          isRecord(read) &&
          typeof read.display === 'string' &&
          typeof read.visibility === 'string'
            ? { display: read.display, visibility: read.visibility }
            : undefined,
        )
      : undefined;
    styles.push({
      frameId: entry.frameId,
      sessionId: entry.sessionId,
      backendNodeIds: bridgeIds(entry),
      result,
    });
  }
  const passwordHistory: Recording['passwordHistory'] = [];
  for (const entry of value.passwordHistory) {
    if (
      !isRecord(entry) ||
      typeof entry.frameId !== 'string' ||
      typeof entry.sessionId !== 'string' ||
      !Array.isArray(entry.result)
    ) {
      throw new Error('Malformed recorded password history.');
    }
    passwordHistory.push({
      frameId: entry.frameId,
      sessionId: entry.sessionId,
      backendNodeIds: bridgeIds(entry),
      result: entry.result.map((flag: unknown) => flag === true),
    });
  }
  return {
    version: RECORDING_VERSION,
    name: value.name,
    chromium: typeof value.chromium === 'string' ? value.chromium : '',
    whitespace: value.whitespace !== false,
    frames,
    responses,
    styles,
    passwordHistory,
    ...(value.measurements === undefined
      ? {}
      : { measurements: decodeMeasurements(value.measurements) }),
    ...(Array.isArray(value.mainWorlds)
      ? { mainWorlds: decodeMainWorlds(value.mainWorlds) }
      : {}),
    ...(Array.isArray(value.controlHistory)
      ? { controlHistory: decodeHistoryCalls(value.controlHistory) }
      : {}),
    ...(Array.isArray(value.controlSummaries)
      ? { controlSummaries: decodeSummaryCalls(value.controlSummaries) }
      : {}),
  };
}

function decodeSummaryCalls(values: unknown[]): RecordedSummaryCall[] {
  const calls: RecordedSummaryCall[] = [];
  for (const entry of values) {
    if (
      !isRecord(entry) ||
      typeof entry.frameId !== 'string' ||
      typeof entry.sessionId !== 'string' ||
      (entry.scope !== 'light' && entry.scope !== 'shadow') ||
      (entry.result !== 'none' &&
        entry.result !== 'some' &&
        entry.result !== 'unknown')
    ) {
      throw new Error('Malformed recorded tracker summary.');
    }
    calls.push({
      frameId: entry.frameId,
      sessionId: entry.sessionId,
      scope: entry.scope,
      result: entry.result,
    });
  }
  return calls;
}

function isHistory(value: unknown): value is ControlHistory {
  return value === 'never' || value === 'was' || value === 'unknown';
}

function decodeHistoryCalls(values: unknown[]): RecordedHistoryCall[] {
  const calls: RecordedHistoryCall[] = [];
  for (const entry of values) {
    if (
      !isRecord(entry) ||
      typeof entry.frameId !== 'string' ||
      typeof entry.sessionId !== 'string' ||
      (entry.scope !== 'light' && entry.scope !== 'shadow') ||
      !Array.isArray(entry.backendNodeIds) ||
      !Array.isArray(entry.result)
    ) {
      throw new Error('Malformed recorded tracker history.');
    }
    calls.push({
      frameId: entry.frameId,
      sessionId: entry.sessionId,
      scope: entry.scope,
      backendNodeIds: entry.backendNodeIds.filter(
        (id): id is number => typeof id === 'number',
      ),
      result: entry.result.filter(isHistory),
    });
  }
  return calls;
}

function decodeMainWorlds(values: unknown[]): RecordedMainWorld[] {
  const worlds: RecordedMainWorld[] = [];
  for (const entry of values) {
    if (
      !isRecord(entry) ||
      typeof entry.frameId !== 'string' ||
      typeof entry.sessionId !== 'string'
    ) {
      throw new Error('Malformed recorded main world.');
    }
    worlds.push({
      frameId: entry.frameId,
      sessionId: entry.sessionId,
      ...(typeof entry.contextId === 'number'
        ? { contextId: entry.contextId }
        : {}),
    });
  }
  return worlds;
}

const cache = new Map<string, Recording>();

/** Loads `recorded/<name>.json`. */
export function loadRecording(name: string): Recording {
  const cached = cache.get(name);
  if (cached) return cached;
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(RECORDED_DIRECTORY, `${name}.json`), 'utf8'),
  );
  const recording = decodeRecording(parsed);
  cache.set(name, recording);
  return recording;
}

/** The fixture page's HTML source, beside its recording. */
export function recordedHtml(name: string): string {
  return readFileSync(path.join(RECORDED_DIRECTORY, `${name}.html`), 'utf8');
}

/** A registry populated the way the host populates it from CDP events. */
export function recordedRegistry(recording: Recording): FrameRegistry {
  const registry = new FrameRegistry();
  for (const frame of recording.frames) {
    if (frame.sessionId !== '') {
      registry.noteAttached(frame.sessionId, {
        targetId: frame.frameId,
        type: 'iframe',
        url: frame.url,
      });
    }
  }
  const ordered = [...recording.frames].sort(
    (first, second) =>
      Number(first.parentId !== undefined) -
      Number(second.parentId !== undefined),
  );
  for (const frame of ordered) {
    registry.noteFrameNavigated(frame.sessionId, {
      id: frame.frameId,
      loaderId: frame.loaderId,
      url: frame.url,
      ...(frame.parentId === undefined ? {} : { parentId: frame.parentId }),
    });
  }
  return registry;
}

/** Replays a recorded response, or rejects for an unrecorded request. */
export function recordedSend(recording: Recording): PageModelDeps['send'] {
  const byKey = new Map<string, unknown>();
  for (const entry of recording.responses) {
    byKey.set(
      `${entry.method}\u0000${entry.sessionId}\u0000${stableParams(entry.params)}`,
      entry.response,
    );
  }
  return async (method, params, sessionId): Promise<unknown> => {
    await Promise.resolve();
    // Recordings hold whole documents, all shallower than the bounded request.
    const recordedParams =
      method === 'DOM.getDocument' && params.depth === PIERCED_DOCUMENT_DEPTH
        ? { ...params, depth: -1 }
        : params;
    const key = `${method}\u0000${sessionId ?? ''}\u0000${stableParams(recordedParams)}`;
    if (!byKey.has(key)) {
      throw new Error(`Unrecorded CDP request ${method}.`);
    }
    return byKey.get(key);
  };
}

function bridgeKey(frameId: string, sessionId: string, ids: number[]): string {
  return JSON.stringify([frameId, sessionId, ids]);
}

export interface ReplayOptions {
  registry?: FrameRegistry;
  send?: PageModelDeps['send'];
  readStyles?: PageModelDeps['readStyles'] | null;
  isPasswordEverSeen?: PageModelDeps['isPasswordEverSeen'];
  mainWorldContextId?: PageModelDeps['mainWorldContextId'];
  /** `null` replays without trackers, as a recording without them does. */
  controlHistory?: PageModelDeps['controlHistory'] | null;
  /** Defaults to the recorded summaries; none when `controlHistory` is null. */
  controlHistorySummary?: PageModelDeps['controlHistorySummary'] | null;
  now?: () => number;
  signal?: AbortSignal;
}

/** Page-model dependencies that replay a recording. */
export function recordedDeps(
  recording: Recording,
  options: ReplayOptions = {},
): PageModelDeps {
  const styles = new Map<
    string,
    Array<PageModelStyleRead | undefined> | undefined
  >();
  for (const call of recording.styles) {
    styles.set(
      bridgeKey(call.frameId, call.sessionId, call.backendNodeIds),
      call.result,
    );
  }
  const history = new Map<string, boolean[]>();
  for (const call of recording.passwordHistory) {
    history.set(
      bridgeKey(call.frameId, call.sessionId, call.backendNodeIds),
      call.result,
    );
  }
  const readStyles: PageModelDeps['readStyles'] = (frameId, sessionId, ids) =>
    Promise.resolve(styles.get(bridgeKey(frameId, sessionId, ids)));
  const mainWorlds = new Map<string, number | undefined>();
  for (const world of recording.mainWorlds ?? []) {
    mainWorlds.set(
      bridgeKey(world.frameId, world.sessionId, []),
      world.contextId,
    );
  }
  const mainWorldContextId: PageModelDeps['mainWorldContextId'] = (
    frameId,
    sessionId,
  ) => mainWorlds.get(bridgeKey(frameId, sessionId, []));
  const trackerAnswers = new Map<string, ControlHistory[]>();
  for (const call of recording.controlHistory ?? []) {
    trackerAnswers.set(
      bridgeKey(
        `${call.scope}:${call.frameId}`,
        call.sessionId,
        call.backendNodeIds,
      ),
      call.result,
    );
  }
  const recordedHistory: PageModelDeps['controlHistory'] = (
    frameId,
    sessionId,
    scope,
    ids,
  ) => {
    const result = trackerAnswers.get(
      bridgeKey(`${scope}:${frameId}`, sessionId, ids),
    );
    return result
      ? Promise.resolve(result)
      : Promise.reject(new Error('Unrecorded tracker history.'));
  };
  const controlHistory =
    options.controlHistory === null
      ? undefined
      : (options.controlHistory ??
        (recording.controlHistory ? recordedHistory : undefined));
  const summaries = new Map<string, TrackerMemory>();
  for (const call of recording.controlSummaries ?? []) {
    summaries.set(
      bridgeKey(`${call.scope}:${call.frameId}`, call.sessionId, []),
      call.result,
    );
  }
  const recordedSummary: PageModelDeps['controlHistorySummary'] = (
    frameId,
    sessionId,
    scope,
  ) => {
    const result = summaries.get(
      bridgeKey(`${scope}:${frameId}`, sessionId, []),
    );
    return result
      ? Promise.resolve(result)
      : Promise.reject(new Error('Unrecorded tracker summary.'));
  };
  const controlHistorySummary =
    options.controlHistory === null || options.controlHistorySummary === null
      ? undefined
      : (options.controlHistorySummary ??
        (recording.controlSummaries ? recordedSummary : undefined));
  const deps: PageModelDeps = {
    registry: options.registry ?? recordedRegistry(recording),
    now: options.now ?? ((): number => 1_800_000_000_000),
    send: options.send ?? recordedSend(recording),
    isPasswordEverSeen:
      options.isPasswordEverSeen ??
      ((frameId, sessionId, ids): Promise<boolean[]> => {
        const result = history.get(bridgeKey(frameId, sessionId, ids));
        return result
          ? Promise.resolve(result)
          : Promise.reject(new Error('Unrecorded password history.'));
      }),
    ...(options.readStyles === null
      ? {}
      : { readStyles: options.readStyles ?? readStyles }),
    mainWorldContextId: options.mainWorldContextId ?? mainWorldContextId,
    ...(controlHistory === undefined ? {} : { controlHistory }),
    ...(controlHistorySummary === undefined ? {} : { controlHistorySummary }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  return deps;
}
