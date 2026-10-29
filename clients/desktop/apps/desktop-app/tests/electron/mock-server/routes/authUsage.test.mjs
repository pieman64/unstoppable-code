// In-process tests for the provider auth/usage mock surface
// (WP-MOCK-AUTHUSAGE, Doc 6). Boots a real loopback server wired to
// `handleAuthUsageRequest` and fetches each endpoint under a registered
// scenario; also unit-tests the pure response builders and relative-reset
// resolution directly.
//
// Run:  node --test apps/desktop-app/tests/electron/mock-server/routes/authUsage.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  handleAuthUsageRequest,
  resolveAuthUsageScenario,
  resolveResetEpochMs,
  resolveResetIso,
  buildClaudeUsageBody,
  buildClaudeAuthBody,
  buildCodexAccountBody,
  buildCodexRateLimitsBody,
} from './authUsage.mjs';
import { registerScenario, resetAll } from '../control-plane.mjs';

function startServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handled = handleAuthUsageRequest(request, response, url);
    if (!handled) {
      response.writeHead(404).end('not handled');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function getJson(base, path, key) {
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  return { status: res.status, body: await res.json() };
}

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

test('account model fixtures preserve modern tiers and legacy string entries', async () => {
  resetAll();
  const futureModel = {
    id: 'future-codex-model',
    model: 'future-codex-model',
    serviceTiers: [
      { id: 'ultrafast', name: 'Ultra fast', description: 'Speed tier' },
    ],
  };
  const emptyModern = {
    id: 'another-future-model',
    model: 'another-future-model',
    serviceTiers: [],
    additionalSpeedTiers: ['ultrafast'],
  };
  registerScenario('model-tiers', {
    codexAccountModels: ['legacy-model', futureModel, emptyModern],
  });
  const { server, base } = await startServer();
  try {
    assert.deepEqual(
      await getJson(base, '/__mock/codex/models', 'model-tiers'),
      {
        status: 200,
        body: {
          data: [
            { id: 'legacy-model', model: 'legacy-model' },
            futureModel,
            emptyModern,
          ],
          nextCursor: null,
        },
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('relative reset tokens resolve to absolute future values', () => {
  assert.equal(resolveResetEpochMs('+2h', NOW), NOW + 2 * 3_600_000);
  assert.equal(resolveResetEpochMs('+5d', NOW), NOW + 5 * 86_400_000);
  assert.equal(resolveResetIso('+2h', NOW), '2026-01-01T02:00:00.000Z');
  // absolute ISO passes through
  assert.equal(
    resolveResetIso('2030-01-01T00:00:00.000Z', NOW),
    '2030-01-01T00:00:00.000Z',
  );
  // numeric epoch passes through; junk → null
  assert.equal(resolveResetEpochMs(12345, NOW), 12345);
  assert.equal(resolveResetEpochMs('nope', NOW), null);
});

test('named scenario resolves from the library', () => {
  resetAll();
  registerScenario('k1', { authUsage: { scenario: 'authed-near-limit' } });
  const scenario = resolveAuthUsageScenario({
    headers: { authorization: 'Bearer k1' },
  });
  assert.equal(scenario.claude.auth.subscriptionType, 'max');
  assert.equal(scenario.claude.usage.five_hour.utilization, 92);
});

test('inline scenario slice is honored', () => {
  resetAll();
  registerScenario('k2', {
    authUsage: {
      claude: { usage: { five_hour: { utilization: 42, resets_at: '+1h' } } },
    },
  });
  const scenario = resolveAuthUsageScenario({
    headers: { authorization: 'Bearer k2' },
  });
  assert.equal(scenario.claude.usage.five_hour.utilization, 42);
});

test('unregistered key falls back to the authed-low-usage default', () => {
  resetAll();
  const scenario = resolveAuthUsageScenario({ headers: {} });
  assert.equal(scenario.claude.auth.loggedIn, true);
  assert.ok(scenario.claude.usage.five_hour.utilization <= 15);
});

test('buildClaudeUsageBody resolves resets and keeps extra_usage', () => {
  const body = buildClaudeUsageBody(
    {
      claude: {
        usage: {
          five_hour: { utilization: 50, resets_at: '+2h' },
          extra_usage: { monthly_limit: 100, used_credits: 10 },
        },
      },
    },
    NOW,
  );
  assert.equal(body.five_hour.utilization, 50);
  assert.equal(body.five_hour.resets_at, '2026-01-01T02:00:00.000Z');
  assert.deepEqual(body.extra_usage, { monthly_limit: 100, used_credits: 10 });
});

test('buildClaudeAuthBody coerces loggedIn', () => {
  assert.equal(
    buildClaudeAuthBody({ claude: { auth: { loggedIn: true } } }).loggedIn,
    true,
  );
  assert.equal(buildClaudeAuthBody({}).loggedIn, false);
});

test('buildCodexAccountBody maps presence to requiresOpenaiAuth', () => {
  const authed = buildCodexAccountBody({
    codex: { account: { type: 'chatgpt', email: 'a@b.com', planType: 'plus' } },
  });
  assert.equal(authed.requiresOpenaiAuth, false);
  assert.equal(authed.account.email, 'a@b.com');

  const unauth = buildCodexAccountBody({ codex: { account: null } });
  assert.equal(unauth.account, null);
  assert.equal(unauth.requiresOpenaiAuth, true);
});

test('buildCodexRateLimitsBody resolves epoch SECONDS and credits balance string', () => {
  const body = buildCodexRateLimitsBody(
    {
      codex: {
        rateLimits: [
          {
            limitId: 'primary',
            primary: {
              usedPercent: 88,
              windowDurationMins: 300,
              resetsAt: '+2h',
            },
            credits: { balance: 12.5 },
          },
        ],
      },
    },
    NOW,
  );
  assert.equal(body.rateLimits.limitId, 'primary');
  assert.equal(body.rateLimits.primary.usedPercent, 88);
  assert.equal(
    body.rateLimits.primary.resetsAt,
    Math.floor((NOW + 2 * 3_600_000) / 1000),
  );
  assert.equal(body.rateLimits.credits.balance, '12.5');
  assert.equal(body.rateLimits.credits.hasCredits, true);
  assert.ok(body.rateLimitsByLimitId.primary);
});

test('endpoints return scenario data over HTTP', async () => {
  resetAll();
  registerScenario('http-key', {
    authUsage: { scenario: 'authed-near-limit' },
  });
  const { server, base } = await startServer();
  try {
    const usage = await getJson(base, '/api/oauth/usage', 'http-key');
    assert.equal(usage.status, 200);
    assert.equal(usage.body.five_hour.utilization, 92);
    assert.ok(usage.body.extra_usage);

    const auth = await getJson(base, '/__mock/claude/auth', 'http-key');
    assert.equal(auth.body.loggedIn, true);
    assert.equal(auth.body.email, 'tester@example.com');

    const account = await getJson(base, '/__mock/codex/account', 'http-key');
    assert.equal(account.body.account.type, 'chatgpt');
    assert.equal(account.body.requiresOpenaiAuth, false);

    const ratelimits = await getJson(
      base,
      '/__mock/codex/ratelimits',
      'http-key',
    );
    assert.equal(ratelimits.body.rateLimits.primary.usedPercent, 88);
    assert.equal(typeof ratelimits.body.rateLimits.primary.resetsAt, 'number');
  } finally {
    server.close();
  }
});

test('Cursor account reads use the request account and preserve failure status', async () => {
  resetAll();
  registerScenario('cursor-account', {
    authUsage: {
      cursor: {
        account: { userId: 'cursor-one', email: 'one@example.com' },
        usage: { enabled: true, planUsage: { totalPercentUsed: 75 } },
        plan: { planInfo: { planName: 'Pro' } },
        hardLimitHttpStatus: 503,
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const read = (method, key = 'cursor-account') =>
      fetch(`${base}/__mock/cursor/${method}`, {
        method: 'POST',
        body: '{}',
        headers: { authorization: `Bearer ${key}` },
      });
    assert.deepEqual(await (await read('GetMe')).json(), {
      userId: 'cursor-one',
      email: 'one@example.com',
    });
    assert.equal(
      (await (await read('GetCurrentPeriodUsage')).json()).planUsage
        .totalPercentUsed,
      75,
    );
    assert.equal(
      (await (await read('GetPlanInfo')).json()).planInfo.planName,
      'Pro',
    );
    assert.equal((await read('GetHardLimit')).status, 503);
    assert.equal((await read('GetMe', 'different-account')).status, 401);
    assert.equal((await read('SetHardLimit')).status, 404);
  } finally {
    server.close();
  }
});

test('forced HTTP status knobs fail the usage endpoints', async () => {
  resetAll();
  registerScenario('fail-key', {
    authUsage: {
      claude: {
        auth: { loggedIn: true, email: 'tester@example.com' },
        usageHttpStatus: 500,
      },
      codex: {
        account: { type: 'chatgpt', email: 'tester@example.com' },
        ratelimitsHttpStatus: 404,
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const usage = await getJson(base, '/api/oauth/usage', 'fail-key');
    assert.equal(usage.status, 500);

    // Auth and account endpoints stay healthy — only the usage/rate-limit
    // fetches are forced to fail, mirroring the real-world failure mode.
    const auth = await getJson(base, '/__mock/claude/auth', 'fail-key');
    assert.equal(auth.status, 200);
    assert.equal(auth.body.loggedIn, true);
    const account = await getJson(base, '/__mock/codex/account', 'fail-key');
    assert.equal(account.status, 200);
    assert.equal(account.body.account.type, 'chatgpt');

    const ratelimits = await getJson(
      base,
      '/__mock/codex/ratelimits',
      'fail-key',
    );
    assert.equal(ratelimits.status, 404);
  } finally {
    server.close();
  }
});

test('forced Claude usage failures can return a Retry-After header', async () => {
  resetAll();
  registerScenario('retry-after-key', {
    authUsage: {
      claude: {
        auth: { loggedIn: true, email: 'tester@example.com' },
        usageHttpStatus: 429,
        usageRetryAfterSeconds: 600,
      },
    },
  });
  const { server, base } = await startServer();
  try {
    const usage = await fetch(`${base}/api/oauth/usage`, {
      headers: { authorization: 'Bearer retry-after-key' },
    });
    assert.equal(usage.status, 429);
    assert.equal(usage.headers.get('retry-after'), '600');
  } finally {
    server.close();
  }
});

test('unauthenticated scenario reports logged out + no account', async () => {
  resetAll();
  registerScenario('out-key', { authUsage: { scenario: 'unauthenticated' } });
  const { server, base } = await startServer();
  try {
    const auth = await getJson(base, '/__mock/claude/auth', 'out-key');
    assert.equal(auth.body.loggedIn, false);
    const account = await getJson(base, '/__mock/codex/account', 'out-key');
    assert.equal(account.body.account, null);
    assert.equal(account.body.requiresOpenaiAuth, true);
  } finally {
    server.close();
  }
});

test('non-GET methods are not handled', () => {
  const response = {
    writeHead() {
      return this;
    },
    end() {},
  };
  const handled = handleAuthUsageRequest(
    { method: 'POST', headers: {} },
    response,
    new URL('http://h/api/oauth/usage'),
  );
  assert.equal(handled, false);
});
