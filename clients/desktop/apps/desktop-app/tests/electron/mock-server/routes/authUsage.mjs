// Provider auth + usage surface for the shared UI-automation mock server
// (WP-MOCK-AUTHUSAGE, Doc 6 §2-4).
//
// The shared server (see ../start.mjs) runs once for the whole Playwright suite
// (Doc 4 §0); these routes are keyed by the request's Bearer credential so
// concurrent workers don't collide on shared state. The app reaches these
// endpoints ONLY under an E2E build (Doc 11), where the gated seams in
// `ipc/settings.ts` and `observability/service.ts` send the per-test key as a
// Bearer token.
//
// Endpoints:
//   GET /api/oauth/usage      → Claude usage windows (utilization + resets_at +
//                               optional extra_usage). Anthropic response shape.
//   GET /__mock/claude/auth   → `{loggedIn,email,orgName,authMethod,
//                               subscriptionType}` (shape `claude auth status
//                               --json` returns).
//   GET /__mock/codex/account → GetAccountResponse `{account,requiresOpenaiAuth}`.
//   GET /__mock/codex/ratelimits → GetAccountRateLimitsResponse
//                               `{rateLimits,rateLimitsByLimitId}`.
//
// Scenario keying: a test registers `{ authUsage: { scenario: '<name>' } }`
// (named from the library below) or inline `{ authUsage: { claude, codex } }`
// under its Bearer key. Relative reset tokens (`+2h`, `+5d`) are resolved to
// absolute values at request time so resets are always future and deterministic
// relative to the run.

import { getScenario, keyFromBearer } from '../control-plane.mjs';

function jsonResponse(response, status, body, headers = {}) {
  response.writeHead(status, {
    'content-type': 'application/json',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

// ── Scenario library (Doc 6 §4) ───────────────────────────────────────────

/**
 * @typedef {object} AuthUsageScenario
 * @property {object} [claude] Auth and usage payloads; auth may include a
 *   `responseDelayMs` test seam for deterministic loading-state assertions,
 *   and `usageHttpStatus` forces `/api/oauth/usage` to fail with that HTTP
 *   status (for usage fetch-error UX coverage). `usageRetryAfterSeconds` adds
 *   a Retry-After header to forced failures when it is a finite non-negative
 *   number.
 * @property {number} [claude.usageRetryAfterSeconds] Seconds to wait before
 *   retrying a forced Claude usage failure.
 * @property {object} [codex] Account/rate-limit payloads;
 *   `ratelimitsHttpStatus` forces `/__mock/codex/ratelimits` to fail with
 *   that HTTP status.
 */

/**
 * Resolve a forced failure status knob from a scenario slice. Returns a
 * usable HTTP status (>= 400) or null when the endpoint should succeed.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function resolveForcedHttpStatus(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400
    ? value
    : null;
}

/** @type {Record<string, AuthUsageScenario>} */
const SCENARIO_LIBRARY = {
  'authed-low-usage': {
    claude: {
      auth: {
        loggedIn: true,
        email: 'tester@example.com',
        authMethod: 'oauth',
        subscriptionType: 'max',
      },
      usage: {
        five_hour: { utilization: 8, resets_at: '+2h' },
        seven_day: { utilization: 12, resets_at: '+5d' },
      },
    },
    codex: {
      account: {
        type: 'chatgpt',
        email: 'tester@example.com',
        planType: 'plus',
      },
      rateLimits: [
        {
          limitId: 'primary',
          primary: {
            usedPercent: 10,
            windowDurationMins: 300,
            resetsAt: '+2h',
          },
          secondary: {
            usedPercent: 6,
            windowDurationMins: 10080,
            resetsAt: '+5d',
          },
          credits: { balance: 25.0 },
        },
      ],
    },
  },
  'authed-near-limit': {
    claude: {
      auth: {
        loggedIn: true,
        email: 'tester@example.com',
        authMethod: 'oauth',
        subscriptionType: 'max',
      },
      usage: {
        five_hour: { utilization: 92, resets_at: '+2h' },
        seven_day: { utilization: 78, resets_at: '+5d' },
        extra_usage: {
          monthly_limit: 100,
          used_credits: 64,
          utilization: 64,
          is_enabled: true,
        },
      },
    },
    codex: {
      account: {
        type: 'chatgpt',
        email: 'tester@example.com',
        planType: 'plus',
      },
      rateLimits: [
        {
          limitId: 'primary',
          primary: {
            usedPercent: 88,
            windowDurationMins: 300,
            resetsAt: '+2h',
          },
          secondary: {
            usedPercent: 70,
            windowDurationMins: 10080,
            resetsAt: '+5d',
          },
          credits: { balance: 12.5 },
        },
      ],
    },
  },
  'usage-limit-reached': {
    claude: {
      auth: {
        loggedIn: true,
        email: 'tester@example.com',
        authMethod: 'oauth',
        subscriptionType: 'max',
      },
      usage: {
        five_hour: { utilization: 100, resets_at: '+2h' },
        seven_day: { utilization: 96, resets_at: '+5d' },
      },
    },
    codex: {
      account: {
        type: 'chatgpt',
        email: 'tester@example.com',
        planType: 'plus',
      },
      rateLimits: [
        {
          limitId: 'primary',
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: '+2h',
          },
          secondary: {
            usedPercent: 88,
            windowDurationMins: 10080,
            resetsAt: '+5d',
          },
          credits: { balance: 0 },
        },
      ],
    },
  },
  unauthenticated: {
    claude: { auth: { loggedIn: false } },
    codex: { account: null },
  },
};

const DEFAULT_SCENARIO_ID = 'authed-low-usage';

/**
 * Resolve the auth/usage scenario for a request's key. Supports a named scenario
 * (`{ authUsage: { scenario } }`) from the library, an inline slice
 * (`{ authUsage: { claude, codex, cursor } }`), or the benign default.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {AuthUsageScenario}
 */
export function resolveAuthUsageScenario(request) {
  const key = keyFromBearer(request);
  const scenario = getScenario(key);
  const slice = scenario?.authUsage;

  if (slice && typeof slice === 'object') {
    if (typeof slice.scenario === 'string') {
      return (
        SCENARIO_LIBRARY[slice.scenario] ??
        SCENARIO_LIBRARY[DEFAULT_SCENARIO_ID]
      );
    }
    if (slice.claude || slice.codex || slice.cursor) {
      return slice;
    }
  }

  return SCENARIO_LIBRARY[DEFAULT_SCENARIO_ID];
}

// ── Relative reset token resolution (`+2h`, `+5d`, …) ──────────────────────

const RELATIVE_TOKEN = /^\+(\d+)(s|m|h|d)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Resolve a relative reset token to an absolute epoch-milliseconds value
 * relative to `now`. Returns `null` for an unparseable/absent token.
 *
 * @param {unknown} token
 * @param {number} [now]
 * @returns {number | null}
 */
export function resolveResetEpochMs(token, now = Date.now()) {
  if (typeof token === 'number' && Number.isFinite(token)) {
    return token;
  }
  if (typeof token !== 'string') {
    return null;
  }
  const match = RELATIVE_TOKEN.exec(token.trim());
  if (match) {
    return now + Number(match[1]) * UNIT_MS[match[2]];
  }
  const parsed = Date.parse(token);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Resolve a relative reset token to an absolute ISO string (or null). */
export function resolveResetIso(token, now = Date.now()) {
  const epochMs = resolveResetEpochMs(token, now);
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

// ── Response builders (pure; unit-tested directly) ─────────────────────────

/**
 * Build the Claude `/api/oauth/usage` body from a scenario's `claude.usage`
 * slice, resolving relative `resets_at` tokens to absolute ISO strings.
 *
 * @param {AuthUsageScenario} scenario
 * @param {number} [now]
 * @returns {object}
 */
export function buildClaudeUsageBody(scenario, now = Date.now()) {
  const usage = scenario?.claude?.usage ?? {};
  const body = {};
  for (const [key, value] of Object.entries(usage)) {
    if (key === 'extra_usage') {
      continue;
    }
    if (!value || typeof value !== 'object') {
      continue;
    }
    body[key] = {
      utilization: value.utilization,
      resets_at: resolveResetIso(value.resets_at, now),
    };
  }
  if (usage.extra_usage && typeof usage.extra_usage === 'object') {
    body.extra_usage = { ...usage.extra_usage };
  }
  return body;
}

/**
 * Build the `claude auth status --json` body from a scenario's `claude.auth`
 * slice.
 *
 * @param {AuthUsageScenario} scenario
 * @returns {object}
 */
export function buildClaudeAuthBody(scenario) {
  const auth = scenario?.claude?.auth ?? { loggedIn: false };
  return {
    loggedIn: auth.loggedIn === true,
    email: auth.email,
    orgName: auth.orgName,
    authMethod: auth.authMethod,
    subscriptionType: auth.subscriptionType,
  };
}

/**
 * Build a Codex `GetAccountResponse` body from a scenario's `codex.account`
 * slice.
 *
 * @param {AuthUsageScenario} scenario
 * @returns {object}
 */
export function buildCodexAccountBody(scenario) {
  const account = scenario?.codex?.account;
  if (!account || typeof account !== 'object') {
    return { account: null, requiresOpenaiAuth: true };
  }
  return { account, requiresOpenaiAuth: false };
}

/**
 * Build a single `RateLimitSnapshot` from a scenario rate-limit entry,
 * resolving relative `resetsAt` tokens to absolute epoch SECONDS (the Codex
 * app-server wire shape `RateLimitWindow.resetsAt` is epoch seconds).
 *
 * @param {object} entry
 * @param {number} [now]
 * @returns {object}
 */
function buildRateLimitSnapshot(entry, now = Date.now()) {
  const toWindow = (window) => {
    if (!window || typeof window !== 'object') {
      return null;
    }
    const epochMs = resolveResetEpochMs(window.resetsAt, now);
    return {
      usedPercent: window.usedPercent ?? 0,
      windowDurationMins: window.windowDurationMins ?? null,
      resetsAt: epochMs === null ? null : Math.floor(epochMs / 1000),
    };
  };
  const credits =
    entry.credits && typeof entry.credits === 'object'
      ? {
          hasCredits: (entry.credits.balance ?? 0) > 0,
          unlimited: false,
          balance:
            entry.credits.balance === undefined ||
            entry.credits.balance === null
              ? null
              : String(entry.credits.balance),
        }
      : null;
  return {
    limitId: entry.limitId ?? null,
    limitName: entry.limitName ?? null,
    primary: toWindow(entry.primary),
    secondary: toWindow(entry.secondary),
    credits,
    planType: entry.planType ?? null,
    rateLimitReachedType: entry.rateLimitReachedType ?? null,
  };
}

/**
 * Build a Codex `GetAccountRateLimitsResponse` body from a scenario's
 * `codex.rateLimits` slice.
 *
 * @param {AuthUsageScenario} scenario
 * @param {number} [now]
 * @returns {object}
 */
export function buildCodexRateLimitsBody(scenario, now = Date.now()) {
  const entries = Array.isArray(scenario?.codex?.rateLimits)
    ? scenario.codex.rateLimits
    : [];
  const snapshots = entries.map((entry) => buildRateLimitSnapshot(entry, now));
  const primary = snapshots[0] ?? {
    limitId: null,
    limitName: null,
    primary: null,
    secondary: null,
    credits: null,
    planType: null,
    rateLimitReachedType: null,
  };
  const rateLimitsByLimitId =
    snapshots.length > 0
      ? Object.fromEntries(
          snapshots.map((snapshot, index) => [
            snapshot.limitId ?? `limit-${index}`,
            snapshot,
          ]),
        )
      : null;
  return { rateLimits: primary, rateLimitsByLimitId };
}

/**
 * Handle a provider auth/usage request. Returns `true` if the request matched a
 * route (and a response was written), `false` otherwise.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {URL} url
 * @returns {boolean}
 */
export function handleAuthUsageRequest(request, response, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === 'POST' && pathname.startsWith('/__mock/cursor/')) {
    const cursor = resolveAuthUsageScenario(request)?.cursor;
    const name = pathname.slice('/__mock/cursor/'.length);
    const field = {
      GetMe: 'account',
      GetCurrentPeriodUsage: 'usage',
      GetPlanInfo: 'plan',
      GetHardLimit: 'hardLimit',
      AvailableModels: 'availableModels',
    }[name];
    if (!field) return false;
    const status = resolveForcedHttpStatus(cursor?.[`${field}HttpStatus`]);
    const send = () =>
      jsonResponse(
        response,
        status ?? (cursor?.account ? 200 : 401),
        status ? { error: 'forced by scenario' } : (cursor?.[field] ?? {}),
      );
    if (cursor?.responseDelayMs > 0) setTimeout(send, cursor.responseDelayMs);
    else send();
    return true;
  }

  if (method !== 'GET') {
    return false;
  }

  if (pathname === '/api/oauth/usage') {
    const scenario = resolveAuthUsageScenario(request);
    const forcedStatus = resolveForcedHttpStatus(
      scenario?.claude?.usageHttpStatus,
    );
    if (forcedStatus !== null) {
      const retryAfterSeconds = scenario?.claude?.usageRetryAfterSeconds;
      const headers =
        typeof retryAfterSeconds === 'number' &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds >= 0
          ? { 'Retry-After': String(retryAfterSeconds) }
          : undefined;
      jsonResponse(
        response,
        forcedStatus,
        { error: 'forced by scenario' },
        headers,
      );
      return true;
    }
    jsonResponse(response, 200, buildClaudeUsageBody(scenario));
    return true;
  }

  if (pathname === '/__mock/claude/auth') {
    const scenario = resolveAuthUsageScenario(request);
    const responseDelayMs = scenario?.claude?.auth?.responseDelayMs;
    if (typeof responseDelayMs === 'number' && responseDelayMs > 0) {
      setTimeout(() => {
        jsonResponse(response, 200, buildClaudeAuthBody(scenario));
      }, responseDelayMs);
    } else {
      jsonResponse(response, 200, buildClaudeAuthBody(scenario));
    }
    return true;
  }

  if (pathname === '/__mock/codex/account') {
    const scenario = resolveAuthUsageScenario(request);
    jsonResponse(response, 200, buildCodexAccountBody(scenario));
    return true;
  }

  // Codex app-server `model/list` for the signed-in account. Scenarios opt in
  // with a top-level `codexAccountModels` array; otherwise the list is
  // unavailable and desktop keeps every native Codex model.
  if (pathname === '/__mock/codex/models') {
    const models = getScenario(keyFromBearer(request))?.codexAccountModels;
    if (!Array.isArray(models)) {
      jsonResponse(response, 404, { error: 'no account model list' });
      return true;
    }
    jsonResponse(response, 200, {
      data: models.map((model) =>
        typeof model === 'string' ? { id: model, model } : model,
      ),
      nextCursor: null,
    });
    return true;
  }

  if (pathname === '/__mock/codex/ratelimits') {
    const scenario = resolveAuthUsageScenario(request);
    const forcedStatus = resolveForcedHttpStatus(
      scenario?.codex?.ratelimitsHttpStatus,
    );
    if (forcedStatus !== null) {
      jsonResponse(response, forcedStatus, { error: 'forced by scenario' });
      return true;
    }
    jsonResponse(response, 200, buildCodexRateLimitsBody(scenario));
    return true;
  }

  return false;
}
