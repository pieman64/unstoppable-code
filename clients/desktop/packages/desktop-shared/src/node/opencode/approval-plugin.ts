/** Immutable host scope; ordinary prompt runtimes expose no session mutations. */
export interface OpenCodeForkScope {
  sourceSessionId: string;
  sourceCwd: string;
  destinationCwd: string;
  createdAfter: number;
  /** Restricts mutations and protects bootstrap identity; every mutation checks provenance. */
  forkSessionId?: string;
}

/** Loaded only from the private, host-authored OpenCode configuration. */
export function openCodeApprovalPlugin(
  url: string,
  token: string,
  shellEnvironment: NodeJS.ProcessEnv,
  forkScope?: OpenCodeForkScope,
): string {
  // Capture only the roots overridden for the provider process, never the
  // caller's credentials or the rest of its environment in the plugin file.
  const shellRoots = [
    'XDG_CONFIG_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
  ].map((key) => [key, shellEnvironment[key] ?? null]);
  return `
import { createServer } from 'node:http';
const endpoint = ${JSON.stringify(url)};
const authorization = ${JSON.stringify(`Bearer ${token}`)};
const shellRoots = ${JSON.stringify(shellRoots)};
const forkScope = ${JSON.stringify(forkScope ?? null)};
// The owning runtime closes this connection on Stop or teardown. Interactive
// approval waits for the host decision and has no independent deadline.
async function decide(payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('The host approval service is unavailable.');
  const result = await response.json();
  if (result.permission !== 'allow') throw new Error(result.agent_message || 'The host denied this tool.');
  return result;
}
async function jsonSchema(input) {
  if (input && (typeof input === 'object' || typeof input === 'function') && 'ast' in input) {
    const { Schema } = await import('effect');
    const document = Schema.toJsonSchemaDocument(input, { onExcessProperty: 'error' });
    return { ...document.schema, ...(Object.keys(document.definitions).length ? { $defs: document.definitions } : {}) };
  }
  if (!input || typeof input !== 'object' || '~standard' in input)
    throw new Error('Unsupported OpenCode tool schema.');
  return input;
}
// Usage credentials stay inside this native process. Only the exact Go API
// endpoint is supported; a custom endpoint reusing its name must never leak a
// credential to OpenCode. Console OAuth and arbitrary providers are unsupported.
const nativeList = value => Array.isArray(value) ? value : value.data;
const sameConnection = (left, right) => left == null && right == null || !!left && !!right &&
  left.type === right.type && (left.type === 'env' ? left.name === right.name : left.id === right.id && left.method === right.method);
function supportsGoUsage(provider, integrationId) {
  return provider.id === 'opencode-go' && integrationId === 'opencode-go' &&
    typeof provider.settings?.baseURL === 'string' &&
    provider.settings.baseURL.replace(/\\/$/, '') === 'https://opencode.ai/zen/go/v1';
}
async function accountUsage(ctx, provider, integrationId, connection) {
  if (!supportsGoUsage(provider, integrationId)) return { status: 'unsupported' };
  if (!connection) return { status: 'not-selected' };
  if (connection.status?.status === 'needs_auth') return { status: 'sign-in-required' };
  if (connection.type !== 'env' && connection.method !== 'key') return { status: 'unsupported' };
  const stillSelected = async () => {
    const current = nativeList(await ctx.provider.list()).find(value => value.id === provider.id);
    return current && supportsGoUsage(current, current.integrationID ?? current.id) &&
      sameConnection(connection, await ctx.integration.connection.active(integrationId));
  };
  try {
    const credential = await ctx.integration.connection.resolve(connection);
    if (credential?.type !== 'key' || typeof credential.key !== 'string' || !credential.key)
      return { status: 'unavailable' };
    if (!await stillSelected()) return { status: 'unavailable' };
    const response = await fetch('https://opencode.ai/zen/go/v1/usage', {
      headers: { authorization: 'Bearer ' + credential.key },
      redirect: 'error', signal: AbortSignal.timeout(3000),
    });
    if (!await stillSelected()) { await response.body?.cancel(); return { status: 'unavailable' }; }
    if (response.status === 401) { await response.body?.cancel(); return { status: 'sign-in-required' }; }
    if (!response.ok) { await response.body?.cancel(); return { status: 'unavailable' }; }
    if (!response.body) return { status: 'unavailable' };
    // Decode once so a multi-byte character split across chunks stays intact.
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 16 * 1024) throw new Error('Usage response too large.');
      chunks.push(Buffer.from(chunk));
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const windows = ['rolling', 'weekly', 'monthly'].map(id => {
      const window = result?.usage?.[id];
      if (!window || !['ok', 'rate-limited'].includes(window.status) ||
          typeof window.percent !== 'number' || !Number.isFinite(window.percent) || window.percent < 0 ||
          typeof window.resetsAt !== 'string' || !Number.isFinite(Date.parse(window.resetsAt)))
        throw new Error('Invalid usage response.');
      // A rate-limited window is exhausted until it resets; overage reads as full.
      const percent = window.status === 'rate-limited' ? 100 : Math.min(window.percent, 100);
      return { id, percent, resetsAt: new Date(window.resetsAt).toISOString() };
    });
    if (!await stillSelected()) return { status: 'unavailable' };
    return { status: 'ready', plan: 'OpenCode Go', checkedAt: new Date().toISOString(), windows };
  } catch { return { status: 'unavailable' }; }
}

// Inserted into the existing authenticated metadata handler. The native v2
// client returns { location, data }; the plugin host can return a direct list.
async function accountMetadata(ctx) {
  const list = nativeList;
  const label = (value) => typeof value === 'string' ? value.slice(0, 320) : '';
  const [providerResult, integrationResult] = await Promise.all([
    ctx.provider.list(), ctx.integration.list(),
  ]);
  const integrations = new Map(list(integrationResult).map(value => [value.id, value]));
  const providers = list(providerResult);
  if (providers.length > 50) throw new Error('Too many providers.');
  // Native providers default to an integration with the same ID.
  const integrationId = provider => provider.integrationID ?? provider.id;
  const accountCount = providers.reduce((total, provider) => total + (integrations.get(integrationId(provider))?.connections.length ?? 0), 0);
  if (accountCount > 200) throw new Error('Too many accounts.');
  const integrationIds = [...new Set(providers.map(integrationId))].filter(id => integrations.has(id));
  const selected = new Map(await Promise.all(integrationIds.map(async id =>
    [id, await ctx.integration.connection.active(id)]
  )));
  const usage = new Map(await Promise.all(providers.map(async provider => [provider.id,
    await accountUsage(ctx, provider, integrationId(provider), selected.get(integrationId(provider))),
  ])));
  // A refresh must never label an old connection as the newly selected account.
  for (const id of integrationIds) {
    if (!sameConnection(selected.get(id), await ctx.integration.connection.active(id)))
      throw new Error('OpenCode account changed during refresh.');
  }
  return { providers: providers.map(provider => {
    const active = selected.get(integrationId(provider));
    const connections = integrations.get(integrationId(provider))?.connections ?? [];
    if (connections.length > 50) throw new Error('Too many accounts.');
    return {
      id: label(provider.id), name: label(provider.name),
      accounts: connections.map(connection => ({
        label: label(connection.type === 'env' ? connection.name : connection.label),
        method: connection.type === 'env' ? 'env' : connection.method,
        selected: !!active && active.type === connection.type &&
          (connection.type === 'env' ? active.name === connection.name : active.id === connection.id),
        needsSignIn: connection.status?.status === 'needs_auth',
        usage: active && active.type === connection.type &&
          (connection.type === 'env' ? active.name === connection.name : active.id === connection.id)
          ? usage.get(provider.id) : { status: supportsGoUsage(provider, integrationId(provider)) &&
            (connection.type === 'env' || connection.method === 'key') ? 'not-selected' : 'unsupported' },
      })),
    };
  }) };
}

// Private continuity metadata, separate from display accounts. Never resolve a
// connection: that API returns credentials. Labels and refreshed values do not
// identify a new connection in v2; credential IDs and environment names do.
async function connectionMetadata(ctx, providerId) {
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\x00-\\x1f\\x7f]/.test(value);
  if (!identifier(providerId)) throw new Error('Invalid provider.');
  const result = await ctx.provider.list();
  const providers = Array.isArray(result) ? result : result.data;
  if (!Array.isArray(providers) || providers.length > 200) throw new Error('Invalid providers.');
  const matches = providers.filter(provider => provider.id === providerId);
  if (matches.length !== 1) throw new Error('Provider unavailable.');
  const integrationId = matches[0].integrationID ?? providerId;
  if (!identifier(integrationId)) throw new Error('Invalid integration.');
  const active = await ctx.integration.connection.active(integrationId);
  let connection = null;
  if (active != null) {
    if (active.type === 'env' && identifier(active.name)) connection = { type: 'env', name: active.name };
    else if (active.type === 'credential' && identifier(active.id) && ['key', 'oauth', 'external'].includes(active.method))
      connection = { type: 'credential', id: active.id, method: active.method };
    else throw new Error('Invalid connection.');
  }
  return { providerId, integrationId, connection };
}

export default {
  id: 'canopy.host-approval',
  async setup(ctx) {
    await ctx.shell.hook('create.before', (event) => {
      for (const [key, value] of shellRoots) event.env[key] = value === null ? undefined : value;
    });
    await ctx.agent.transform((editor) => {
      for (const agent of editor.list()) editor.update(agent.id, (draft) => {
        draft.permissions = [
          { action: '*', resource: '*', effect: 'ask' },
          ...['execute', 'subagent', 'question', 'plan_enter', 'plan_exit'].map(action => ({ action, resource: '*', effect: 'deny' })),
        ];
      });
    });
    // ACP adds selected servers after plugin setup. Transform their configuration
    // before native discovery so late MCP registrations remain individual calls.
    await ctx.mcp.transform((editor) => {
      for (const [name] of editor.list()) editor.update(name, (draft) => { draft.codemode = false; });
    });
    await ctx.tool.hook('execute.before', async (event) => {
      const result = await decide({ kind: 'tool', sessionId: event.sessionID, toolCallId: event.id, toolName: event.tool, toolArgs: event.input });
      if (result.updated_input) {
        const approved = result.updated_input;
        if (!approved || typeof approved !== 'object' || Array.isArray(approved))
          throw new Error('The host returned invalid tool arguments.');
        // V2 validates and executes the hook's resulting input.
        event.input = approved;
      }
    });
    // ACP owns its server credentials. Expose only the metadata the host needs,
    // using the existing per-turn approval secret, never the native server API.
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== authorization) {
        response.writeHead(401).end();
        return;
      }
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        let result;
        if (request.method === 'POST' && url.pathname === '/fork' && forkScope) {
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString('utf8');
            if (Buffer.byteLength(body) > 4096) { response.writeHead(413).end(); return; }
          }
          const input = JSON.parse(body);
          const id = input?.sessionId;
          if (typeof id !== 'string' || !id || id.length > 256 || id === forkScope.sourceSessionId ||
              (forkScope.forkSessionId && id !== forkScope.forkSessionId) ||
              !['move', 'remove'].includes(input.operation)) { response.writeHead(403).end(); return; }
          const session = await ctx.session.get({ sessionID: id });
          if (session.id !== id || session.parentID != null || session.fork?.sessionID !== forkScope.sourceSessionId ||
              !Number.isSafeInteger(session.time?.created) || session.time.created < forkScope.createdAfter ||
              ![forkScope.sourceCwd, forkScope.destinationCwd].includes(session.location?.directory)) {
            response.writeHead(403).end(); return;
          }
          if (input.operation === 'remove') await ctx.session.remove({ sessionID: id });
          else {
            await ctx.session.move({ sessionID: id, directory: forkScope.destinationCwd });
            const deadline = Date.now() + 10000;
            while ((await ctx.session.get({ sessionID: id })).location.directory !== forkScope.destinationCwd) {
              if (Date.now() >= deadline) throw new Error('Native fork move did not complete.');
              await new Promise(resolve => setTimeout(resolve, 25));
            }
          }
          result = { sessionId: id };
        } else if (request.method !== 'GET') { response.writeHead(405).end(); return; }
        else if (/^\\/sessions\\/[^/]+\\/context$/.test(url.pathname)) {
          result = { data: await ctx.session.context({ sessionID: decodeURIComponent(url.pathname.split('/')[2]) }) };
        }
        else if (url.pathname === '/models') result = await ctx.model.list();
        else if (url.pathname === '/accounts') result = await accountMetadata(ctx);
        else if (url.pathname === '/connection') result = await connectionMetadata(ctx, url.searchParams.get('provider'));
        else if (url.pathname === '/tools') result = await Promise.all((await ctx.tool.list()).map(async (tool) => ({
          id: tool.id, description: tool.description, parameters: await jsonSchema(tool.input),
        })));
        else if (/^\\/sessions\\/[^/]+$/.test(url.pathname)) {
          try { result = await ctx.session.get({ sessionID: decodeURIComponent(url.pathname.slice('/sessions/'.length)) }); }
          catch (error) {
            if (error?._tag === 'SessionNotFoundError') { response.writeHead(404).end(); return; }
            throw error;
          }
        } else { response.writeHead(404).end(); return; }
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error('Metadata exceeds the size limit.');
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      } catch { response.writeHead(503).end(); }
    });
    const close = async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    };
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await decide({ kind: 'ready', serverUrl: 'http://127.0.0.1:' + server.address().port });
      return close;
    } catch (error) { await close(); throw error; }
  },
};
`;
}
