import { DEFAULT_MOCK_BASE_URL } from './registerScenario.mjs';
import { registerShareMembership } from './shareMembership.mjs';

/**
 * Shared-plan cloud scenario helpers for the mock server's
 * `routes/shared-plans.mjs` surface.
 *
 * Register once, before the app drives the surface: registering the same key
 * again resets the mock's shared-plan state and activity counters. Change a
 * running scenario (teammate threads, replies, resolution, signals) through
 * the control helpers below, and read what the desktop sent with
 * `readSharedPlanRequests`.
 */

/**
 * The `sharedPlans` scenario slice.
 *
 * @param {{
 *   plans?: object[],
 *   stream?: 'enabled' | 'disabled',
 *   enforceSnapshotHash?: boolean,
 *   signalOnPut?: boolean,
 *   getDelayMs?: number,
 *   getError?: { status?: number, body?: object },
 *   putError?: { status?: number, body?: object },
 * }} [options] `plans` are `sharedPlanServerSeed(...)` results
 */
export function sharedPlanScenario({
  plans = [],
  stream = 'enabled',
  enforceSnapshotHash = true,
  signalOnPut = false,
  getDelayMs,
  getError,
  putError,
} = {}) {
  return {
    sharedPlans: {
      plans,
      stream,
      enforceSnapshotHash,
      signalOnPut,
      ...(getDelayMs === undefined ? {} : { getDelayMs }),
      ...(getError === undefined ? {} : { getError }),
      ...(putError === undefined ? {} : { putError }),
    },
  };
}

/**
 * Register share membership (one organization and team, like
 * `registerShareMembership`) plus the shared-plan slice for `apiKey`.
 *
 * @param {string} apiKey the `csk_` key the spec signs in with
 * @param {Parameters<typeof sharedPlanScenario>[0] & {
 *   baseUrl?: string,
 *   organizations?: object[],
 *   teams?: object[],
 *   scenario?: object,
 * }} [options]
 */
export async function registerSharedPlanScenario(apiKey, options = {}) {
  const {
    baseUrl,
    organizations,
    teams,
    scenario = {},
    ...planOptions
  } = options;
  return registerShareMembership(apiKey, {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(organizations === undefined ? {} : { organizations }),
    ...(teams === undefined ? {} : { teams }),
    scenario: { ...scenario, ...sharedPlanScenario(planOptions) },
  });
}

function controlUrl(baseUrl, apiKey, remoteId, suffix = '') {
  const origin = (baseUrl ?? DEFAULT_MOCK_BASE_URL).replace(/\/+$/, '');
  return `${origin}/__mock/shared-plans/${encodeURIComponent(apiKey)}/${encodeURIComponent(remoteId)}${suffix}`;
}

async function controlRequest(url, body) {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) {
    throw new Error(
      `Shared-plan mock control ${url} responded ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

/** Add a teammate thread (wire shape) on the server. Signals by default. */
export function addSharedPlanThread(
  apiKey,
  remoteId,
  thread,
  { signal = true, baseUrl } = {},
) {
  return controlRequest(controlUrl(baseUrl, apiKey, remoteId, '/threads'), {
    thread,
    signal,
  });
}

/** Append a teammate reply (wire comment) to a server thread. */
export function addSharedPlanReply(
  apiKey,
  remoteId,
  threadId,
  comment,
  { signal = true, baseUrl } = {},
) {
  return controlRequest(
    controlUrl(
      baseUrl,
      apiKey,
      remoteId,
      `/threads/${encodeURIComponent(threadId)}/comments`,
    ),
    { comment, signal },
  );
}

/** Resolve (`resolved`) or reopen (`open`) a server thread. */
export function setSharedPlanThreadStatus(
  apiKey,
  remoteId,
  threadId,
  status,
  { signal = true, baseUrl } = {},
) {
  return controlRequest(
    controlUrl(
      baseUrl,
      apiKey,
      remoteId,
      `/threads/${encodeURIComponent(threadId)}/status`,
    ),
    { status, signal },
  );
}

/** Emit a `plan.detail` signal without changing the plan. */
export function emitSharedPlanSignal(apiKey, remoteId, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, remoteId, '/signal'), {});
}

/**
 * What the desktop sent: `{ puts: [{ receivedAt, body,
 * expectedSnapshotHashMatched }], gets, streamConnections, openStreams,
 * events }`.
 */
export function readSharedPlanRequests(apiKey, remoteId, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, remoteId, '/requests'));
}

/** The server's current `SharedPlanDetail`. */
export function readSharedPlanDetail(apiKey, remoteId, { baseUrl } = {}) {
  return controlRequest(controlUrl(baseUrl, apiKey, remoteId));
}
