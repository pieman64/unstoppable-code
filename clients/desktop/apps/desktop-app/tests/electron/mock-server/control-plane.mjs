// Mock-server control plane (per-test scenario keying).
//
// The shared mock server (see ./start.mjs) runs ONCE for the whole Playwright
// suite (Doc 4 §0) while tests run with `--workers=2`. To keep concurrent tests
// from colliding on shared mock state, every per-test scenario is registered
// under a credential `key` and each surface resolves the key off the incoming
// request (Authorization token / API key / `[Canopy-C<id>]` marker).
// Unregistered keys resolve to a benign default scenario so untouched surfaces
// stay inert.
//
// ── Scenario object shape (the single JSON contract all surfaces code against) ──
//
//   {
//     // Canopy Cloud surface slice (account / portal / capabilities overrides).
//     cloud?:     object,
//     // LLM surface slice (canned conversation selection, helper fingerprints,
//     // streaming/usage/stop-reason overrides) — WP-MOCK-LLM.
//     llm?:       object,
//     // GitHub REST surface slice (PR / check-run / user state) — WP-MOCK-GITHUB.
//     github?:    object,
//     // Linear GraphQL surface slice (viewer / issueSearch / issue) —
//     // WP-MOCK-LINEAR.
//     linear?:    object,
//     // Provider auth + usage surface slice (Claude/Codex auth + usage cards) —
//     // WP-MOCK-AUTHUSAGE.
//     authUsage?: object,
//   }
//
// Every field is optional. Each surface WP owns and documents the inner shape of
// its own slice in a later phase; the control plane treats slices as opaque
// JSON and only guarantees registration/resolution/reset semantics.
//
// See ./README.md for the HTTP control-plane API and full contract.

/**
 * The benign default scenario returned for any unregistered key. All slices are
 * absent so each surface falls back to its own inert default behaviour.
 *
 * @type {Readonly<{}>}
 */
export const DEFAULT_SCENARIO = Object.freeze({});

/** @type {Map<string, object>} */
const scenarios = new Map();

/** @type {Map<string, Record<string, number>>} */
const scenarioActivity = new Map();

/**
 * Register a per-test scenario under a credential key. A falsy key is ignored.
 *
 * @param {string} key
 * @param {object} scenario
 */
export function registerScenario(key, scenario) {
  if (!key) {
    return;
  }
  scenarios.set(key, scenario ?? {});
  scenarioActivity.delete(key);
}

/**
 * Resolve the scenario registered under `key`, or the benign default scenario
 * when nothing is registered (including for a falsy key).
 *
 * @param {string} [key]
 * @returns {object}
 */
export function getScenario(key) {
  if (!key) {
    return DEFAULT_SCENARIO;
  }
  return scenarios.get(key) ?? DEFAULT_SCENARIO;
}

/**
 * Increment one observed activity counter for a registered scenario key.
 * Activity is test-only evidence that the provider-facing request arrived; it
 * is kept outside the scripted scenario so the mock response stays stateless.
 *
 * @param {string | undefined} key
 * @param {string} field
 */
export function recordScenarioActivity(key, field) {
  if (!key || !field) {
    return;
  }
  const activity = scenarioActivity.get(key) ?? {};
  activity[field] = (activity[field] ?? 0) + 1;
  scenarioActivity.set(key, activity);
}

/**
 * Return observed activity counters for a scenario key.
 *
 * @param {string | undefined} key
 * @returns {Record<string, number>}
 */
export function getScenarioActivity(key) {
  if (!key) {
    return {};
  }
  return { ...(scenarioActivity.get(key) ?? {}) };
}

/**
 * Remove the scenario registered under `key`.
 *
 * @param {string} key
 * @returns {boolean} whether a scenario was removed
 */
export function clearScenario(key) {
  if (!key) {
    return false;
  }
  scenarioActivity.delete(key);
  return scenarios.delete(key);
}

/** Remove every registered scenario. */
export function resetAll() {
  scenarios.clear();
  scenarioActivity.clear();
}

/**
 * Extract the credential key from an Authorization header.
 *
 * Most Canopy mock surfaces use `Bearer`, but Octokit sends classic PAT/OAuth
 * tokens as `token <key>`. Accept both so GitHub UI automation can key mock
 * scenarios off the same token the app passes to the real Octokit client.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {string | undefined}
 */
export function keyFromBearer(request) {
  const authorization = request.headers?.authorization ?? '';
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Extract the credential key from an API-key header or query parameter.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {{ header?: string, query?: string, url?: URL }} [options]
 *   `header` — request header name to read (case-insensitive).
 *   `query` — query-parameter name to read (requires `url`).
 *   `url` — parsed request URL used for query lookups.
 * @returns {string | undefined}
 */
export function keyFromApiKey(request, options = {}) {
  const { header, query, url } = options;

  if (header) {
    const raw = request.headers?.[header.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) {
      return value.trim();
    }
  }

  if (query && url) {
    const value = url.searchParams.get(query);
    if (value) {
      return value.trim();
    }
  }

  return undefined;
}

/**
 * Extract a `[Canopy-C<id>]` marker key from arbitrary text (e.g. an LLM prompt
 * or system message). Returns the full marker (e.g. `Canopy-C7`) so surfaces can
 * key scenarios off it directly.
 *
 * @param {string} [text]
 * @returns {string | undefined}
 */
export function markerFromText(text) {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = /\[(Canopy-C[A-Za-z0-9_-]+)\]/.exec(text);
  return match ? match[1] : undefined;
}

// Routes sharing /graphql may inspect a request and then decline it. Retain
// the parsed body so the next route does not wait on an already-ended stream.
const jsonRequestBodies = new WeakMap();

/**
 * Read and JSON-parse a request body. Returns `undefined` on empty or invalid
 * JSON so callers can respond with a 400 instead of throwing.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<object | undefined>}
 */
export function readJsonBody(request) {
  const existing = jsonRequestBodies.get(request);
  if (existing) return existing;
  const body = new Promise((resolve) => {
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
        resolve(undefined);
      }
    });
    request.on('error', () => resolve(undefined));
  });
  jsonRequestBodies.set(request, body);
  return body;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Handle a `/__mock/*` control-plane request.
 *
 *   POST   /__mock/state        body `{ key, scenario }` → register a scenario
 *   GET    /__mock/state/:key                            → the scenario for key
 *   GET    /__mock/activity/:key                         → activity counters
 *   DELETE /__mock/state/:key                            → clear the scenario
 *   POST   /__mock/reset                                 → clear all scenarios
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {Promise<boolean>} `true` if a `/__mock/*` route was handled
 */
export async function handleControlPlaneRequest(request, response, url) {
  const { pathname } = url;
  if (!pathname.startsWith('/__mock/')) {
    return false;
  }

  const method = request.method;

  if (method === 'POST' && pathname === '/__mock/reset') {
    resetAll();
    jsonResponse(response, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && pathname === '/__mock/state') {
    const body = await readJsonBody(request);
    if (!body || typeof body.key !== 'string' || !body.key) {
      jsonResponse(response, 400, {
        error: 'Expected JSON body { key: string, scenario?: object }.',
      });
      return true;
    }
    registerScenario(body.key, body.scenario ?? {});
    jsonResponse(response, 200, { ok: true, key: body.key });
    return true;
  }

  const stateMatch = /^\/__mock\/state\/(.+)$/.exec(pathname);
  if (stateMatch) {
    const key = decodeURIComponent(stateMatch[1]);

    if (method === 'GET') {
      jsonResponse(response, 200, { key, scenario: getScenario(key) });
      return true;
    }

    if (method === 'DELETE') {
      const cleared = clearScenario(key);
      jsonResponse(response, 200, { ok: true, cleared });
      return true;
    }
  }

  const activityMatch = /^\/__mock\/activity\/(.+)$/.exec(pathname);
  if (activityMatch && method === 'GET') {
    const key = decodeURIComponent(activityMatch[1]);
    jsonResponse(response, 200, {
      key,
      activity: getScenarioActivity(key),
    });
    return true;
  }

  jsonResponse(response, 404, {
    error: `Unhandled control-plane route: ${method} ${pathname}`,
  });
  return true;
}
