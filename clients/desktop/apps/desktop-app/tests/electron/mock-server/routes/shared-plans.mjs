// Shared-plan cloud surface (plan workspace panels, phase 01).
//
// Serves the desktop owner's shared-plan client paths so Electron specs can
// drive teammate comments through the real cloud client, IPC, persistence
// merge, update event, and plan renderer:
//
//   GET  /api/v1/<ns>/plans/:id          → full `SharedPlanDetail`
//   PUT  /api/v1/<ns>/plans/:id          → merge `commentThreads`, record body
//   GET  /api/v1/<ns>/plans/:id/stream   → `plan.detail` SSE signals
//
// Client sources: `apps/desktop-app/src/main/plans/canopy-server-client.ts`
// and `plan-realtime-subscription.ts`. Wire shapes:
// `packages/protocol/src/plans/index.ts` (`SharedPlanDetail`,
// `WirePlanCommentThread`, `SharedPlanUpdateRequest`) and
// `packages/protocol/src/realtime/index.ts` (`PlanRealtimeSignal`). The SSE
// framing mirrors `apps/web/src/lib/realtime/sse-core.ts`.
//
// State is keyed by the bearer credential like every other surface. A key
// without a registered `sharedPlans` slice answers 404, so specs that never
// opt in see the same "no plan route" behavior as before this module existed.
// Runtime state lives on the registered scenario object
// (`scenario.sharedPlansState`) and is dropped with it by `clearScenario`.
// Re-registering a key mid-run wipes that state (and its activity counters),
// so tests mutate a running scenario only through the control routes:
//
//   POST /__mock/shared-plans/:key/:planId/threads                     { thread, signal? }
//   POST /__mock/shared-plans/:key/:planId/threads/:threadId/comments  { comment, signal? }
//   POST /__mock/shared-plans/:key/:planId/threads/:threadId/status    { status, signal? }
//   POST /__mock/shared-plans/:key/:planId/signal                      {}
//   POST /__mock/shared-plans/:key/:planId/faults                      { getError }
//   POST /__mock/shared-plans/:key/:planId/streams/close               {}
//   GET  /__mock/shared-plans/:key/:planId/requests  → { puts, gets, streamConnections, openStreams, events }
//   GET  /__mock/shared-plans/:key/:planId           → current detail
//
// Deliberate differences from the web service, noted for reviewers:
//   - PUT bumps `remoteRevisionNumber` only when `snapshotHash` changes, like
//     `updateSharedPlan` in `apps/web/src/lib/plans/plan-service.ts`, but it
//     trusts the client's `snapshotHash` instead of recomputing it.
//   - Signals come from an explicit per-plan event log. Control routes signal
//     by default (`signal: false` opts out); a PUT signals only when the
//     scenario sets `signalOnPut: true`, so startup sync stays quiet.

import { createHash } from 'node:crypto';
import {
  DEFAULT_SCENARIO,
  getScenario,
  keyFromBearer,
  recordScenarioActivity,
} from '../control-plane.mjs';

const DETAIL_PATH = /^\/api\/v1\/[^/]+\/plans\/([^/]+)$/;
const STREAM_PATH = /^\/api\/v1\/[^/]+\/plans\/([^/]+)\/stream$/;
const CONTROL_PATH = /^\/__mock\/shared-plans\/([^/]+)\/([^/]+)(\/.*)?$/;

const STREAM_POLL_MS = 100;
const STREAM_KEEPALIVE_MS = 15_000;
const STREAM_RETRY_ADVICE_MS = 3_000;

/** Fixed fixture timestamp for seeded details that do not supply their own. */
export const SHARED_PLAN_MOCK_TIME = '2026-06-11T12:00:00.000Z';

/** Team owner that mirrors `seeders/shareMembership.mjs`. */
export const SHARED_PLAN_MOCK_TEAM_OWNER = Object.freeze({
  type: 'team',
  id: '55555555-5555-4555-8555-555555555551',
  name: 'Platform',
  organization: Object.freeze({
    id: '44444444-4444-4444-8444-444444444441',
    name: 'Acme Robotics',
  }),
});

const MOCK_CREATED_BY = Object.freeze({
  id: 'account-e2e',
  name: 'Portal E2E',
  email: 'portal-e2e@example.test',
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Sorted-key JSON so value-equal diagrams hash identically. */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function diagramsHash(diagrams) {
  return sha256Hex(stableStringify(diagrams ?? null));
}

/**
 * Fill a seeded (possibly partial) shared plan into a complete
 * `SharedPlanDetail`. The default owner is the share-membership team so the
 * desktop's `shareFromRemote` keeps a visible team share after every GET/PUT.
 */
export function buildSharedPlanDetail(seed) {
  if (!seed || typeof seed.id !== 'string' || seed.id.length === 0) {
    throw new Error('A shared-plan seed requires a remote id.');
  }
  if (typeof seed.content !== 'string') {
    throw new Error(`Shared-plan seed ${seed.id} requires content.`);
  }
  if (typeof seed.snapshotHash !== 'string' || seed.snapshotHash.length === 0) {
    throw new Error(`Shared-plan seed ${seed.id} requires a snapshotHash.`);
  }
  const detail = {
    id: seed.id,
    title: seed.title ?? 'Shared plan',
    contentHash: sha256Hex(seed.content),
    diagramsHash: diagramsHash(seed.diagrams),
    snapshotHash: seed.snapshotHash,
    localRevisionNumber: seed.localRevisionNumber ?? 1,
    remoteRevisionNumber: seed.remoteRevisionNumber ?? 1,
    repositories: clone(seed.repositories ?? []),
    shareScope: seed.shareScope ?? 'team',
    owner: clone(seed.owner ?? SHARED_PLAN_MOCK_TEAM_OWNER),
    createdBy: clone(seed.createdBy ?? MOCK_CREATED_BY),
    createdAt: seed.createdAt ?? SHARED_PLAN_MOCK_TIME,
    updatedAt: seed.updatedAt ?? SHARED_PLAN_MOCK_TIME,
    canUpdate: seed.canUpdate ?? true,
    canDelete: seed.canDelete ?? true,
    content: seed.content,
    commentThreads: clone(seed.commentThreads ?? []),
  };
  if (seed.diagrams !== undefined) {
    detail.diagrams = clone(seed.diagrams);
  }
  return detail;
}

/**
 * Merge desktop-pushed wire threads into the server copy the way the web's
 * `syncInboundCommentThreads` does: upsert threads by id taking the incoming
 * status/anchor/anchorState, append comments with new ids, never delete, and
 * keep server-only (web-authored) threads. An existing comment is never
 * overwritten (the web upserts it with an empty update), so a desktop push
 * cannot replace a teammate's text.
 */
export function mergeWireCommentThreads(existing, incoming) {
  const merged = clone(existing ?? []);
  for (const thread of incoming ?? []) {
    const current = merged.find((candidate) => candidate.id === thread.id);
    if (!current) {
      merged.push(clone(thread));
      continue;
    }
    current.status = thread.status;
    current.anchor = clone(thread.anchor);
    current.anchorState = thread.anchorState;
    for (const comment of thread.comments ?? []) {
      const exists = current.comments.some(
        (candidate) => candidate.id === comment.id,
      );
      if (!exists) {
        current.comments.push(clone(comment));
      }
    }
  }
  return merged;
}

/** One SSE frame carrying a `RealtimeEventEnvelope<PlanRealtimeSignal>`. */
export function formatPlanDetailFrame(event, remoteId) {
  const envelope = {
    type: 'plan.detail',
    eventId: `mock-plan-event-${event.id}`,
    occurredAt: event.occurredAt,
    sequence: event.id,
    payload: { planId: remoteId, revision: event.revision },
  };
  return `id: ${event.id}\nevent: plan.detail\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Resolve the replay cursor like the web: `Last-Event-ID` first, then
 * `?after`, accepting only non-negative integers. `null` means "no cursor",
 * which starts the stream at the current head.
 */
export function parseStreamCursor(request, url) {
  const header = request.headers?.['last-event-id'];
  const raw =
    (Array.isArray(header) ? header[0] : header) ??
    url.searchParams.get('after');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    return null;
  }
  return Number(raw.trim());
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    request.on('error', () => resolve(null));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function initialState(config) {
  const plans = {};
  for (const seed of config.plans ?? []) {
    plans[seed.id] = {
      detail: buildSharedPlanDetail(seed),
      events: [],
      puts: [],
      gets: 0,
      streamConnections: 0,
      openStreams: 0,
      // Per-plan GET failure set at runtime through `/faults`; it takes
      // precedence over the scenario's `getError`.
      getError: null,
      // Enders of this plan's open streams, for `/streams/close`.
      streamEnders: new Set(),
    };
  }
  return { nextEventId: 1, plans };
}

/**
 * Runtime state for `key`, or `null` when the key has no `sharedPlans` slice.
 * The frozen default scenario is never mutated.
 */
function stateForKey(key) {
  const scenario = getScenario(key);
  if (scenario === DEFAULT_SCENARIO || !scenario?.sharedPlans) {
    return null;
  }
  scenario.sharedPlansState ??= initialState(scenario.sharedPlans);
  return scenario.sharedPlansState;
}

function configForKey(key) {
  return getScenario(key)?.sharedPlans ?? {};
}

function appendSignal(state, entry) {
  const event = {
    id: state.nextEventId,
    revision: entry.detail.remoteRevisionNumber,
    occurredAt: new Date().toISOString(),
  };
  state.nextEventId += 1;
  entry.events.push(event);
  return event;
}

function requireBearer(request, response) {
  const authorization = request.headers?.authorization ?? '';
  if (/^Bearer\s+csk_/.test(authorization)) {
    return true;
  }
  jsonResponse(response, 401, { error: 'Invalid API key.' });
  return false;
}

function planEntry(key, remoteId) {
  return stateForKey(key)?.plans[remoteId] ?? null;
}

async function handleDetailGet(request, response, key, remoteId) {
  const entry = planEntry(key, remoteId);
  if (!entry) {
    jsonResponse(response, 404, { error: 'Plan not found' });
    return;
  }
  const config = configForKey(key);
  if (typeof config.getDelayMs === 'number' && config.getDelayMs > 0) {
    await delay(config.getDelayMs);
  }
  entry.gets += 1;
  recordScenarioActivity(key, 'sharedPlanGet');
  const getError = entry.getError ?? config.getError;
  if (getError) {
    jsonResponse(
      response,
      getError.status ?? 500,
      getError.body ?? { error: 'Shared plan read failed.' },
    );
    return;
  }
  jsonResponse(response, 200, clone(entry.detail));
}

async function handleDetailPut(request, response, key, remoteId) {
  const entry = planEntry(key, remoteId);
  if (!entry) {
    jsonResponse(response, 404, { error: 'Plan not found' });
    return;
  }
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    jsonResponse(response, 400, { error: 'Expected a JSON plan update.' });
    return;
  }
  const config = configForKey(key);
  const expectedSnapshotHashMatched =
    body.expectedSnapshotHash === entry.detail.snapshotHash;
  entry.puts.push({
    receivedAt: new Date().toISOString(),
    body: clone(body),
    expectedSnapshotHashMatched,
  });
  recordScenarioActivity(key, 'sharedPlanPut');
  if (config.putError) {
    jsonResponse(
      response,
      config.putError.status ?? 500,
      config.putError.body ?? { error: 'Shared plan update failed.' },
    );
    return;
  }
  if (config.enforceSnapshotHash !== false && !expectedSnapshotHashMatched) {
    jsonResponse(response, 409, {
      error: 'Plan has changed since it was loaded',
    });
    return;
  }

  const detail = entry.detail;
  if (
    typeof body.snapshotHash === 'string' &&
    body.snapshotHash !== detail.snapshotHash
  ) {
    if (typeof body.title === 'string') detail.title = body.title;
    if (typeof body.content === 'string') detail.content = body.content;
    if (typeof body.localRevisionNumber === 'number') {
      detail.localRevisionNumber = body.localRevisionNumber;
    }
    if (Array.isArray(body.repositories)) {
      detail.repositories = clone(body.repositories);
    }
    if (body.diagrams === undefined) {
      delete detail.diagrams;
    } else {
      detail.diagrams = clone(body.diagrams);
    }
    detail.snapshotHash = body.snapshotHash;
    detail.contentHash = sha256Hex(detail.content);
    detail.diagramsHash = diagramsHash(detail.diagrams);
    detail.remoteRevisionNumber += 1;
  }
  if (Array.isArray(body.commentThreads)) {
    detail.commentThreads = mergeWireCommentThreads(
      detail.commentThreads,
      body.commentThreads,
    );
  }
  if (config.signalOnPut === true) {
    appendSignal(stateForKey(key), entry);
  }
  jsonResponse(response, 200, clone(detail));
}

function handleStream(request, response, url, key, remoteId) {
  const entry = planEntry(key, remoteId);
  if (!entry || configForKey(key).stream === 'disabled') {
    jsonResponse(response, 404, { error: 'Not found.' });
    return;
  }
  entry.streamConnections += 1;
  entry.openStreams += 1;
  recordScenarioActivity(key, 'sharedPlanStreamOpen');

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write(`retry: ${STREAM_RETRY_ADVICE_MS}\n: connected\n\n`);

  const cursor = parseStreamCursor(request, url);
  let lastSent = cursor ?? entry.events.at(-1)?.id ?? 0;
  let lastWriteAt = Date.now();
  let closed = false;

  const flush = () => {
    if (closed || response.destroyed || response.writableEnded) {
      return;
    }
    // Re-read the registered scenario every tick rather than holding `entry`,
    // so a cleared (or re-registered) scenario ends the stream.
    const latest = stateForKey(key)?.plans[remoteId];
    if (latest !== entry) {
      response.end();
      return;
    }
    for (const event of latest.events) {
      if (event.id > lastSent) {
        response.write(formatPlanDetailFrame(event, remoteId));
        lastSent = event.id;
        lastWriteAt = Date.now();
      }
    }
    if (Date.now() - lastWriteAt >= STREAM_KEEPALIVE_MS) {
      response.write(': keepalive\n\n');
      lastWriteAt = Date.now();
    }
  };

  const timer = setInterval(flush, STREAM_POLL_MS);
  timer.unref?.();
  // `/streams/close` ends the response like a dropped connection; the client
  // reconnects with `Last-Event-ID` and the event log replays what it missed.
  const end = () => {
    if (!response.writableEnded) response.end();
  };
  entry.streamEnders.add(end);
  flush();
  response.on('close', () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    entry.streamEnders.delete(end);
    entry.openStreams -= 1;
  });
}

function isWireComment(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    (value.author === 'user' ||
      value.author === 'agent' ||
      value.author === 'remote') &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string'
  );
}

function isWireThread(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    (value.status === 'open' || value.status === 'resolved') &&
    typeof value.createdAt === 'string' &&
    value.anchor !== null &&
    typeof value.anchor === 'object' &&
    typeof value.anchor.quote === 'string' &&
    (value.anchorState === 'matched' || value.anchorState === 'outdated') &&
    Array.isArray(value.comments) &&
    value.comments.every(isWireComment)
  );
}

function controlResult(response, entry, event) {
  jsonResponse(response, 200, {
    ok: true,
    detail: clone(entry.detail),
    eventId: event?.id ?? null,
  });
}

async function handleControl(request, response, match) {
  const key = decodeURIComponent(match[1]);
  const remoteId = decodeURIComponent(match[2]);
  const subpath = match[3] ?? '';
  const method = request.method;
  const state = stateForKey(key);
  const entry = state?.plans[remoteId];
  if (!state || !entry) {
    jsonResponse(response, 404, {
      error: `No shared plan ${remoteId} registered for ${key}.`,
    });
    return;
  }

  if (method === 'GET' && (subpath === '' || subpath === '/')) {
    jsonResponse(response, 200, clone(entry.detail));
    return;
  }

  if (method === 'GET' && subpath === '/requests') {
    jsonResponse(response, 200, {
      puts: clone(entry.puts),
      gets: entry.gets,
      streamConnections: entry.streamConnections,
      openStreams: entry.openStreams,
      events: clone(entry.events),
    });
    return;
  }

  if (method !== 'POST') {
    jsonResponse(response, 404, {
      error: `Unhandled shared-plan control route: ${method} ${subpath}`,
    });
    return;
  }

  // `readJsonBody` yields `undefined` for an empty body (a bare `/signal`)
  // and `null` for malformed JSON.
  const parsed = await readJsonBody(request);
  const body = parsed === undefined ? {} : parsed;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    jsonResponse(response, 400, { error: 'Expected a JSON object body.' });
    return;
  }
  const signal = body.signal !== false;

  if (subpath === '/signal') {
    controlResult(response, entry, appendSignal(state, entry));
    return;
  }

  if (subpath === '/faults') {
    const getError = body.getError ?? null;
    if (
      getError !== null &&
      (typeof getError !== 'object' || Array.isArray(getError))
    ) {
      jsonResponse(response, 400, {
        error: 'Expected getError to be { status?, body? } or null.',
      });
      return;
    }
    entry.getError = clone(getError);
    controlResult(response, entry);
    return;
  }

  if (subpath === '/streams/close') {
    const closed = entry.streamEnders.size;
    for (const end of [...entry.streamEnders]) end();
    jsonResponse(response, 200, { ok: true, closed });
    return;
  }

  if (subpath === '/threads') {
    if (!isWireThread(body.thread)) {
      jsonResponse(response, 400, { error: 'Expected a wire thread.' });
      return;
    }
    if (
      entry.detail.commentThreads.some((thread) => thread.id === body.thread.id)
    ) {
      jsonResponse(response, 409, {
        error: `Thread ${body.thread.id} already exists.`,
      });
      return;
    }
    entry.detail.commentThreads.push(clone(body.thread));
    controlResult(
      response,
      entry,
      signal ? appendSignal(state, entry) : undefined,
    );
    return;
  }

  const threadMatch = /^\/threads\/([^/]+)\/(comments|status)$/.exec(subpath);
  if (threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const thread = entry.detail.commentThreads.find(
      (candidate) => candidate.id === threadId,
    );
    if (!thread) {
      jsonResponse(response, 404, { error: `Unknown thread ${threadId}.` });
      return;
    }
    if (threadMatch[2] === 'comments') {
      if (!isWireComment(body.comment)) {
        jsonResponse(response, 400, { error: 'Expected a wire comment.' });
        return;
      }
      if (thread.comments.some((comment) => comment.id === body.comment.id)) {
        jsonResponse(response, 409, {
          error: `Comment ${body.comment.id} already exists.`,
        });
        return;
      }
      thread.comments.push(clone(body.comment));
    } else {
      if (body.status !== 'open' && body.status !== 'resolved') {
        jsonResponse(response, 400, {
          error: 'Expected status "open" or "resolved".',
        });
        return;
      }
      thread.status = body.status;
    }
    controlResult(
      response,
      entry,
      signal ? appendSignal(state, entry) : undefined,
    );
    return;
  }

  jsonResponse(response, 404, {
    error: `Unhandled shared-plan control route: ${method} ${subpath}`,
  });
}

/**
 * Handle a shared-plan cloud or control route. Returns `true` when the request
 * was answered. Unhandled methods on the plan paths return `false` so the
 * remaining surfaces keep their existing behavior.
 */
export async function handleSharedPlansRequest(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  const controlMatch = CONTROL_PATH.exec(pathname);
  if (controlMatch) {
    await handleControl(request, response, controlMatch);
    return true;
  }

  const streamMatch = STREAM_PATH.exec(pathname);
  if (streamMatch && method === 'GET') {
    if (!requireBearer(request, response)) return true;
    handleStream(
      request,
      response,
      url,
      keyFromBearer(request),
      decodeURIComponent(streamMatch[1]),
    );
    return true;
  }

  const detailMatch = DETAIL_PATH.exec(pathname);
  if (detailMatch && (method === 'GET' || method === 'PUT')) {
    if (!requireBearer(request, response)) return true;
    const key = keyFromBearer(request);
    const remoteId = decodeURIComponent(detailMatch[1]);
    if (method === 'GET') {
      await handleDetailGet(request, response, key, remoteId);
    } else {
      await handleDetailPut(request, response, key, remoteId);
    }
    return true;
  }

  return false;
}
