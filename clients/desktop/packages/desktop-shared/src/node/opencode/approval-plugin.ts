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
// Inserted into the existing authenticated metadata handler. The native v2
// client returns { location, data }; the plugin host can return a direct list.
async function accountMetadata(ctx) {
  const list = (value) => Array.isArray(value) ? value : value.data;
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
