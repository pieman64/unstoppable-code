// A fake CLIProxyAPI v8 server for the account proxy specs (CAN-4019,
// CAN-4020). Responses follow what a real v8.0.27 server returned for the
// same requests: `X-CPA-VERSION` on every response, 401 for a wrong key,
// signed-in accounts from `/credentials`, API-key accounts and routing from
// `/config`, `PATCH /credentials/status`, `DELETE /credentials?name=`, the
// client key list at `/config/access/api-keys`, and `PUT
// /config/routing/strategy` (a JSON string, saved as sent, as v8.0.28 does).
//
// With `upstreamUrl`, it also serves Claude model requests the way a real
// proxy with session affinity does: it checks the client key, keeps each
// session id on one ready account, forwards the request to the upstream model
// server, and names the account in `X-CPA-TRACE-ID`.
//
// With `state.codexModels`, it also answers `GET /v1/models?client_version=`
// with that Codex `/models` wire catalog, as CLIProxyAPI does for Codex
// clients (CAN-4302).

import { createServer, request as httpRequest } from 'node:http';
import { compareSync } from 'bcryptjs';

export const FAKE_PROXY_MANAGEMENT_KEY = 'mk-e2e-management';

function signIn({ authIndex, provider, email, planType }) {
  return {
    auth_index: authIndex,
    provider,
    type: provider,
    email,
    label: email,
    name: `${provider}-${email}.json`,
    status: 'active',
    status_message: '',
    disabled: false,
    unavailable: false,
    cooldowns: [],
    quota: { signals: {} },
    ...(planType ? { id_token: { plan_type: planType } } : {}),
  };
}

/** Four accounts: three sign-ins (one cooling down) and one API key. */
export function defaultFakeProxyState(now = Date.now()) {
  const resetSeconds = Math.floor(now / 1000) + 2 * 3600;
  const cooling = signIn({
    authIndex: '9b07e1aa9b07e1aa',
    provider: 'claude',
    email: 'ops@example.com',
  });
  cooling.status = 'error';
  cooling.unavailable = true;
  cooling.next_retry_after = new Date(now + 90 * 60_000).toISOString();
  cooling.cooldowns = [
    {
      scope: 'credential',
      reason: 'quota',
      retry_at: cooling.next_retry_after,
    },
  ];
  const sam = signIn({
    authIndex: 'a1f3c2d4a1f3c2d4',
    provider: 'claude',
    email: 'sam@example.com',
  });
  sam.quota = {
    signals: {
      'anthropic-ratelimit-unified-5h-utilization': '0.64',
      'anthropic-ratelimit-unified-5h-reset': String(resetSeconds),
      'anthropic-ratelimit-unified-7d-utilization': '0.38',
    },
  };
  return {
    files: [
      sam,
      cooling,
      signIn({
        authIndex: '4c55d0194c55d019',
        provider: 'codex',
        email: 'sam@example.com',
        planType: 'pro',
      }),
    ],
    config: {
      access: { 'api-keys': ['ck-e2e-client'] },
      'api-keys': {
        claude: [
          {
            name: 'team-key',
            'base-url': 'http://127.0.0.1:1',
            keys: [
              {
                'api-key': 'sk-must-never-appear',
                auth_index: 'e2a8f640e2a8f640',
              },
            ],
          },
        ],
      },
      routing: { strategy: 'round-robin', 'session-affinity': true },
    },
  };
}

/**
 * Starts the fake server on a free loopback port. `requests` records every
 * management call (method, path, body) so specs can assert what was sent.
 */
/** Accounts that can serve a Claude request now, in the server's order. */
function readyClaudeAccounts(state) {
  const signIns = state.files
    .filter(
      (file) =>
        file.provider === 'claude' && !file.disabled && !file.unavailable,
    )
    .map((file) => file.auth_index);
  const keys = (state.config['api-keys']?.claude ?? []).flatMap((entry) =>
    entry.keys.map((key) => key.auth_index),
  );
  return [...signIns, ...keys];
}

function traceTime(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** The account a browser sign-in through the fake proxy adds. */
export const FAKE_PROXY_SIGNED_IN_ACCOUNT = signIn({
  authIndex: 'b2c3d4e5b2c3d4e5',
  provider: 'claude',
  email: 'new@example.com',
  planType: 'max',
});

/**
 * Options: `port` and `managementKey` (both optional) run it as the proxy on
 * a device; `managementKeyHash` checks the key against a bcrypt hash instead,
 * as the proxy on this device does with the hash the app writes (CAN-4406);
 * `signInAfterPolls` finishes a browser sign-in on that status
 * poll, adding {@link FAKE_PROXY_SIGNED_IN_ACCOUNT}.
 *
 * As in CLIProxyAPI 8.0.28, only a sign-in started with `is_webui` catches
 * the browser's redirect itself (here: on its own, after the polls). Any
 * other waits for `POST /oauth/callback` with its `state` and a `code` or
 * `error`, which needs no management key; a code adds the account, an error
 * fails the sign-in with the proxy's "Bad request".
 */
export async function startFakeAccountProxy(options = {}) {
  const state = options.state ?? defaultFakeProxyState();
  const version = options.version ?? '8.0.27';
  const managementKey = options.managementKey ?? FAKE_PROXY_MANAGEMENT_KEY;
  const managementKeyHash = options.managementKeyHash ?? null;
  const acceptsManagementKey = (authorization) => {
    if (!managementKeyHash) return authorization === `Bearer ${managementKey}`;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    return token !== null && compareSync(token, managementKeyHash);
  };
  const signInAfterPolls = options.signInAfterPolls ?? 2;
  /**
   * Browser sign-ins by state: how many status polls each has had, whether
   * it catches its own redirect, and the callback it was sent.
   */
  const signIns = new Map();
  /** Sign-in callbacks received, for specs to assert on. */
  const callbacks = [];
  const requests = [];
  /** Model requests, with the headers the specs assert on. */
  const modelRequests = [];
  /** Codex catalog reads, with whether they carried a known client key. */
  const codexCatalogRequests = [];
  const sessionAccounts = new Map();
  let nextAccount = 0;
  let requestCount = 0;

  const serveModelRequest = (req, res, url, raw) => {
    const clientKeys = state.config.access?.['api-keys'] ?? [];
    const presented =
      req.headers['x-api-key'] ??
      req.headers.authorization?.replace(/^Bearer /, '');
    const ready = readyClaudeAccounts(state);
    const sessionId =
      req.headers['x-session-id'] ?? req.headers['x-claude-code-session-id'];
    let authIndex = sessionId ? sessionAccounts.get(sessionId) : undefined;
    if (!authIndex || !ready.includes(authIndex)) {
      authIndex = ready[nextAccount % ready.length];
      nextAccount += 1;
      if (sessionId) sessionAccounts.set(sessionId, authIndex);
    }
    modelRequests.push({
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      sessionId: req.headers['x-session-id'] ?? null,
      parentSessionId: req.headers['x-parent-session-id'] ?? null,
      claudeSessionId: req.headers['x-claude-code-session-id'] ?? null,
      canopyHeaders: Object.keys(req.headers).filter((name) =>
        name.startsWith('x-canopy-'),
      ),
      authIndex,
    });
    if (clientKeys.length > 0 && !clientKeys.includes(presented)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'x-cpa-version': version,
      });
      res.end(JSON.stringify({ error: 'Invalid API key' }));
      return;
    }
    requestCount += 1;
    const refusal = options.modelRefusal?.({ state, raw, requestCount });
    if (refusal) {
      res.writeHead(refusal.status, {
        'content-type': 'application/json',
        'x-cpa-version': version,
      });
      res.end(JSON.stringify(refusal.body));
      return;
    }
    const upstream = new URL(url.pathname + url.search, options.upstreamUrl);
    const forwarded = httpRequest(
      upstream,
      {
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
          ...(req.headers['anthropic-beta']
            ? { 'anthropic-beta': req.headers['anthropic-beta'] }
            : {}),
          'x-api-key': options.upstreamApiKey ?? 'mock',
          authorization: `Bearer ${options.upstreamApiKey ?? 'mock'}`,
          'content-length': Buffer.byteLength(raw),
        },
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode ?? 502, {
          ...upstreamResponse.headers,
          'x-cpa-version': version,
          'x-cpa-trace-id': `${traceTime(new Date())}-${authIndex}-${String(
            requestCount,
          ).padStart(4, '0')}`,
        });
        upstreamResponse.pipe(res);
      },
    );
    forwarded.on('error', () => {
      res.writeHead(502, { 'x-cpa-version': version });
      res.end();
    });
    forwarded.end(raw);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (
        req.method === 'GET' &&
        url.pathname === '/v1/models' &&
        url.searchParams.has('client_version') &&
        Array.isArray(state.codexModels)
      ) {
        const clientKeys = state.config.access?.['api-keys'] ?? [];
        const presented = req.headers.authorization?.replace(/^Bearer /, '');
        codexCatalogRequests.push({
          clientVersion: url.searchParams.get('client_version'),
          authorized: clientKeys.includes(presented),
        });
        res.writeHead(clientKeys.includes(presented) ? 200 : 401, {
          'content-type': 'application/json',
          'x-cpa-version': version,
        });
        res.end(
          JSON.stringify(
            clientKeys.includes(presented)
              ? { models: state.codexModels }
              : { error: 'Invalid API key' },
          ),
        );
        return;
      }
      if (options.upstreamUrl && url.pathname.startsWith('/v1/messages')) {
        serveModelRequest(req, res, url, raw);
        return;
      }
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({
        method: req.method,
        path: url.pathname + url.search,
        body,
      });
      const send = (status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'x-cpa-version': version,
        });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/healthz') {
        send(200, { status: 'ok' });
        return;
      }
      if (!url.pathname.startsWith('/v8/management')) {
        send(404, { error: 'not found' });
        return;
      }
      if (
        req.method === 'POST' &&
        url.pathname === '/v8/management/oauth/callback'
      ) {
        const signInState = typeof body?.state === 'string' ? body.state : '';
        const code = typeof body?.code === 'string' ? body.code : '';
        const error = typeof body?.error === 'string' ? body.error : '';
        if (!signInState) {
          send(400, { status: 'error', error: 'state is required' });
          return;
        }
        if (!code && !error) {
          send(400, { status: 'error', error: 'code or error is required' });
          return;
        }
        const pending = signIns.get(signInState);
        if (!pending) {
          send(404, { status: 'error', error: 'unknown or expired state' });
          return;
        }
        if (pending.callback) {
          send(409, { status: 'error', error: 'oauth flow is not pending' });
          return;
        }
        pending.callback = { code, error };
        callbacks.push({ state: signInState, code, error });
        send(200, { status: 'ok' });
        return;
      }
      if (!acceptsManagementKey(req.headers.authorization)) {
        send(401, { error: 'invalid management key' });
        return;
      }
      const path = url.pathname.slice('/v8/management'.length);
      if (req.method === 'POST' && path === '/requests/api-call') {
        const authIndex = body?.auth_index ?? body?.authIndex;
        const file = state.files.find(
          (entry) => entry.auth_index === authIndex,
        );
        const isProfile =
          file?.provider === 'claude' &&
          body?.url === 'https://api.anthropic.com/api/oauth/profile';
        const expectedUrl = isProfile
          ? 'https://api.anthropic.com/api/oauth/profile'
          : file?.provider === 'claude'
            ? 'https://api.anthropic.com/api/oauth/usage'
            : file?.provider === 'codex'
              ? 'https://chatgpt.com/backend-api/wham/usage'
              : null;
        if (
          !expectedUrl ||
          body?.method !== 'GET' ||
          body?.url !== expectedUrl ||
          body?.header?.Authorization !== 'Bearer $TOKEN$' ||
          (file?.provider === 'codex' &&
            file.id_token?.chatgpt_account_id &&
            Object.entries(body?.header ?? {}).find(
              ([name]) => name.toLowerCase() === 'chatgpt-account-id',
            )?.[1] !== file.id_token.chatgpt_account_id)
        ) {
          send(400, { error: 'Invalid quota request' });
          return;
        }
        const response = isProfile
          ? state.profileByAuthIndex?.[authIndex]
          : state.usageByAuthIndex?.[authIndex];
        send(200, {
          status_code: response?.status ?? (response ? 200 : 501),
          header: response?.headers ?? {},
          body: JSON.stringify(
            response?.body ?? { error: 'Usage unavailable' },
          ),
        });
        return;
      }
      if (req.method === 'GET' && path === '/credentials') {
        if (options.beforeCredentialsRead)
          await options.beforeCredentialsRead();
        send(200, {
          files: state.files,
          observed_at: new Date().toISOString(),
        });
        return;
      }
      if (req.method === 'GET' && path === '/config') {
        send(200, state.config);
        return;
      }
      if (path === '/config/access/api-keys') {
        state.config.access ??= {};
        if (req.method === 'GET') {
          send(200, state.config.access['api-keys'] ?? []);
          return;
        }
        if (req.method === 'PUT' && Array.isArray(body)) {
          state.config.access['api-keys'] = body;
          send(200, { status: 'ok' });
          return;
        }
      }
      if (
        req.method === 'PUT' &&
        path === '/config/routing/strategy' &&
        typeof body === 'string'
      ) {
        state.config.routing = { ...state.config.routing, strategy: body };
        send(200, { status: 'ok', 'config-version': 8 });
        return;
      }
      if (req.method === 'GET' && path === '/oauth/auth-url') {
        const provider = url.searchParams.get('provider');
        const host = provider === 'codex' ? 'auth.openai.com' : 'claude.ai';
        const signInState = `e2esignin${String(signIns.size + 1).padStart(8, '0')}`;
        const webui = ['1', 'true', 'yes', 'on'].includes(
          (url.searchParams.get('is_webui') ?? '').toLowerCase(),
        );
        signIns.set(signInState, { polls: 0, webui, callback: null });
        send(200, {
          status: 'ok',
          url: `https://${host}/oauth/authorize?state=${signInState}`,
          state: signInState,
        });
        return;
      }
      if (req.method === 'GET' && path === '/oauth/status') {
        const signInState = url.searchParams.get('state');
        if (!signIns.has(signInState)) {
          send(200, { status: 'error', error: 'unknown or expired state' });
          return;
        }
        const pending = signIns.get(signInState);
        pending.polls += 1;
        if (!pending.webui) {
          if (!pending.callback) {
            send(200, { status: 'wait' });
            return;
          }
          if (pending.callback.error) {
            signIns.delete(signInState);
            send(200, { status: 'error', error: 'Bad request' });
            return;
          }
        } else if (pending.polls < signInAfterPolls) {
          send(200, { status: 'wait' });
          return;
        }
        signIns.delete(signInState);
        if (
          !state.files.some(
            (file) =>
              file.auth_index === FAKE_PROXY_SIGNED_IN_ACCOUNT.auth_index,
          )
        ) {
          state.files.push({ ...FAKE_PROXY_SIGNED_IN_ACCOUNT });
        }
        send(200, { status: 'ok' });
        return;
      }
      if (req.method === 'DELETE' && path === '/oauth/session') {
        signIns.delete(url.searchParams.get('state'));
        send(200, { status: 'ok', cancelled: true });
        return;
      }
      if (req.method === 'PATCH' && path === '/credentials/status') {
        const file = state.files.find((entry) => entry.name === body?.name);
        if (!file) {
          send(404, { error: 'auth file not found' });
          return;
        }
        file.disabled = body.disabled === true;
        file.status = file.disabled ? 'disabled' : 'active';
        send(200, { status: 'ok' });
        return;
      }
      if (req.method === 'DELETE' && path === '/credentials') {
        const name = url.searchParams.get('name');
        const before = state.files.length;
        state.files = state.files.filter((entry) => entry.name !== name);
        send(before === state.files.length ? 404 : 200, { status: 'ok' });
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolve),
  );
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    modelRequests,
    codexCatalogRequests,
    callbacks,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
