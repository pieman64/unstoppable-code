import { createServer } from 'node:http';
import { MCP_CATALOG_API_VERSION } from '@canopy/protocol/mcp-catalog';
import { handleCloudRequest } from '../mock-server/routes/cloud.mjs';

export const ACCOUNT_MCP_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const CUSTOM_ACCOUNT_MCP_ID = 'cccccccc-dddd-4eee-8fff-000000000000';
export const ACCOUNT_MCP_FIXTURE_SIGN_IN_PATH =
  '/api/mcp-connections/authorize?state=fixture-state';
/**
 * @param {{
 *   includeConnection?: boolean,
 *   listFailure?: number | 'offline',
 *   edits?: boolean,
 *   clientSetup?: object,
 *   connections?: Array<Record<string, unknown>>,
 *   endpointRequired?: boolean,
 *   curatedServers?: object[],
 *   signInUnavailable?: { desktopSignIn: boolean },
 *   signInPage?: boolean,
 * }} options
 * `edits` advertises `mcp-connections-v2`: PATCH edits and `DELETE ?remove=1`.
 * `connections` lists further curated connections beside the GitHub one, for
 * example a Personal and a Work connection to one provider (REG-3033).
 * `endpointRequired` refuses a catalog start without `endpointUrl` the way the
 * broker refuses one for a server with several endpoints; `curatedServers`
 * answers the curated MCP catalog read. `signInUnavailable` refuses a catalog
 * start the way the broker refuses a server that lets only approved apps sign
 * in (REG-3048), with the body `connectionRoute` serializes. `signInPage`
 * answers a browser sign-in with the cloud's sign-in page beside the provider
 * URL, as current clouds do; without it the start answers the way older
 * clouds do. The fixture also mints auth links (`authLinks` records each
 * destination) and receives the app's external opens at `externalOpenUrl`
 * (`externalOpens`), so a spec sees which page the browser was sent to.
 * `answerSignIn(error)` makes the next auth-link page send the browser to the
 * OAuth callback with the provider's `error` (for example `access_denied`),
 * which the callback handles as the cloud's does: the connection stays
 * PENDING and records the mapped code in `lastError`.
 */
export async function startAccountMcpCloud({
  includeConnection = true,
  listFailure,
  edits = true,
  // Answers a catalog start that brings no OAuth client the way the broker
  // answers a server without dynamic registration.
  clientSetup,
  connections: extraConnections = [],
  endpointRequired = false,
  curatedServers,
  signInUnavailable,
  signInPage = false,
} = {}) {
  let connection = includeConnection ? makeConnection('DISCONNECTED') : null;
  const extras = extraConnections.map((entry) => ({ ...entry }));
  const customs = [];
  const calls = [];
  const authLinks = [];
  const externalOpens = [];
  let curatedReads = 0;
  let catalogOffline = false;
  let signInAnswer = null;
  let disconnectWait;
  let releaseDisconnect;
  const catalogRequests = [];
  const browserSignIn = () => ({
    authorizationUrl: 'https://auth.example.test/authorize',
    ...(signInPage ? { signInPath: ACCOUNT_MCP_FIXTURE_SIGN_IN_PATH } : {}),
  });
  // A custom start with a bearer token connects at once; without one it
  // answers with a browser sign-in, as the web broker does.
  function makeCustom(body) {
    const suffix = String(customs.length).padStart(12, '0');
    return {
      id:
        customs.length === 0
          ? CUSTOM_ACCOUNT_MCP_ID
          : `dddddddd-eeee-4fff-8aaa-${suffix}`,
      serverKey: `custom:fixture-${customs.length}`,
      configId: body.configId,
      displayName: body.displayName ?? new URL(body.customUrl).hostname,
      kind: 'CUSTOM',
      authMode: body.bearerToken ? 'BEARER' : 'OAUTH',
      status: body.bearerToken ? 'CONNECTED' : 'PENDING',
      routeId: `fixture-custom-route-${customs.length}`,
      enabledTools: null,
      lastError: null,
      upstreamHost: new URL(body.customUrl).hostname,
      hasExtraHeaders: Boolean(
        body.headers && Object.keys(body.headers).length > 0,
      ),
    };
  }
  // Mirrors the broker's PATCH: a new address drops the sign-in unless the
  // same request brings a token.
  function editCustom(custom, body) {
    const next = { ...custom };
    if (body.displayName !== undefined) next.displayName = body.displayName;
    if (body.headers !== undefined)
      next.hasExtraHeaders = Object.keys(body.headers).length > 0;
    if (body.customUrl !== undefined) {
      next.upstreamHost = new URL(body.customUrl).hostname;
      next.status = 'REAUTH_REQUIRED';
    }
    if (typeof body.bearerToken === 'string') {
      next.authMode = 'BEARER';
      next.status = 'CONNECTED';
    } else if (body.bearerToken === null) {
      next.authMode = 'NONE';
      next.status = 'REAUTH_REQUIRED';
    }
    return next;
  }
  function makeConnection(status, serverKey = 'github') {
    return {
      id: ACCOUNT_MCP_ID,
      serverKey,
      configId: 'default',
      // The GitHub name is what existing specs read; any other catalog key
      // names itself after the key the way the broker does.
      displayName:
        serverKey === 'github'
          ? 'Account GitHub'
          : serverKey.charAt(0).toUpperCase() + serverKey.slice(1),
      kind: 'CURATED',
      status,
      routeId: 'fixture-route',
      enabledTools: null,
      lastError: null,
    };
  }
  // Every pending connection for `serverKey`, wherever the fixture keeps it.
  function updatePending(serverKey, change) {
    if (connection?.serverKey === serverKey && connection.status === 'PENDING')
      connection = { ...connection, ...change };
    for (const [index, entry] of extras.entries())
      if (entry.serverKey === serverKey && entry.status === 'PENDING')
        extras[index] = { ...entry, ...change };
    for (const [index, entry] of customs.entries())
      if (entry.serverKey === serverKey && entry.status === 'PENDING')
        customs[index] = { ...entry, ...change };
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith('/.well-known/')) {
      send(200, {
        capabilities: [
          'pipelines-crud-v1',
          'account-v1',
          'organizations-v1',
          'teams-v1',
          'mcp-connections-v1',
          'mcp-proxy-v1',
          ...(edits ? ['mcp-connections-v2'] : []),
        ],
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/external-open') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      externalOpens.push(JSON.parse(Buffer.concat(chunks).toString()).url);
      send(200, { ok: true });
      return;
    }
    if (
      request.method === 'GET' &&
      url.pathname.endsWith('/auth-link/consume') &&
      signInAnswer
    ) {
      // The provider answered the sign-in with an error instead of a code.
      const callback = new URL(
        `/api/mcp-connections/callback/${encodeURIComponent(signInAnswer.serverKey)}`,
        `http://${request.headers.host}`,
      );
      callback.searchParams.set('error', signInAnswer.error);
      callback.searchParams.set('state', 'fixture-state');
      response.writeHead(302, { Location: callback.toString() });
      response.end();
      return;
    }
    const callbackKey = /^\/api\/mcp-connections\/callback\/([^/]+)$/.exec(
      url.pathname,
    )?.[1];
    if (request.method === 'GET' && callbackKey) {
      // Mirrors the cloud's failCallback: the flow is spent, the connection
      // keeps its PENDING status and records the mapped provider code.
      const error = url.searchParams.get('error');
      if (error && url.searchParams.get('state'))
        updatePending(decodeURIComponent(callbackKey), {
          lastError:
            error === 'access_denied' ? 'access_denied' : 'oauth_error',
        });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><title>Couldn’t finish signing in</title>' +
          '<p>Couldn’t finish signing in. Close this tab.</p>' +
          '<script>try{window.close()}catch(e){}</script>',
      );
      return;
    }
    if (request.method === 'POST' && url.pathname.endsWith('/auth-link')) {
      if (!/^Bearer csk_/.test(request.headers.authorization ?? '')) {
        send(401, { error: 'Sign in' });
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      authLinks.push(JSON.parse(Buffer.concat(chunks).toString()).redirectPath);
      send(200, {
        url: `http://${request.headers.host}${url.pathname}/consume?code=fixture`,
      });
      return;
    }
    if (
      request.method === 'GET' &&
      curatedServers &&
      url.pathname.endsWith('/mcp-servers/curated')
    ) {
      curatedReads += 1;
      catalogRequests.push({
        path: url.pathname,
        authorizationPresent: request.headers.authorization !== undefined,
      });
      if (catalogOffline) {
        request.socket.destroy();
        return;
      }
      send(200, { version: MCP_CATALOG_API_VERSION, servers: curatedServers });
      return;
    }
    if (url.pathname.includes('/mcp-proxy/')) {
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      send(200, {
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'fixture', version: '1' },
              }
            : {
                tools: [
                  { name: 'account_search', inputSchema: { type: 'object' } },
                ],
              },
      });
      return;
    }
    if (url.pathname.includes('/mcp-connections')) {
      if (!/^Bearer csk_/.test(request.headers.authorization ?? '')) {
        send(401, { error: 'Sign in' });
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : undefined;
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body,
      });
      if (request.method === 'DELETE') await disconnectWait;
      const customIndex = customs.findIndex((entry) =>
        url.pathname.includes(entry.id),
      );
      const custom = customIndex >= 0 ? customs[customIndex] : null;
      if (request.method === 'POST' && body.customUrl) {
        const created = makeCustom(body);
        customs.push(created);
        send(
          200,
          created.status === 'CONNECTED'
            ? { connection: created }
            : browserSignIn(),
        );
        return;
      }
      if (custom && request.method === 'DELETE') {
        if (edits && url.searchParams.get('remove') === '1')
          customs.splice(customIndex, 1);
        else customs[customIndex] = { ...custom, status: 'DISCONNECTED' };
        send(200, { ok: true });
        return;
      }
      if (
        custom &&
        request.method === 'PATCH' &&
        !url.pathname.endsWith('/tools')
      ) {
        if (!edits) {
          send(404, { error: 'not_found' });
          return;
        }
        customs[customIndex] = editCustom(custom, body);
        send(200, { connection: customs[customIndex] });
        return;
      }
      // Reconnecting a custom connection by its key starts a browser sign-in.
      const reconnecting = customs.findIndex(
        (entry) => entry.serverKey === body?.serverKey,
      );
      if (request.method === 'POST' && reconnecting >= 0) {
        customs[reconnecting] = {
          ...customs[reconnecting],
          status: 'PENDING',
          lastError: null,
        };
        send(200, browserSignIn());
        return;
      }
      // Reconnecting a listed curated connection by key and config starts a
      // browser sign-in on that connection rather than creating another.
      const reconnectingExtra = extras.findIndex(
        (entry) =>
          entry.serverKey === body?.serverKey &&
          entry.configId === body?.configId,
      );
      if (request.method === 'POST' && reconnectingExtra >= 0) {
        extras[reconnectingExtra] = {
          ...extras[reconnectingExtra],
          status: 'PENDING',
          lastError: null,
        };
        send(200, browserSignIn());
        return;
      }
      if (request.method === 'POST' && endpointRequired && !body.endpointUrl) {
        send(400, { error: 'endpoint_required', code: 'endpoint_required' });
        return;
      }
      if (request.method === 'POST' && signInUnavailable && body.serverKey) {
        send(400, {
          error: 'sign_in_unavailable',
          code: 'sign_in_unavailable',
          desktopSignIn: signInUnavailable.desktopSignIn,
        });
        return;
      }
      if (request.method === 'POST' && clientSetup && !body.oauthClient) {
        send(400, {
          error: 'client_credentials_required',
          code: 'client_credentials_required',
          clientSetup,
        });
        return;
      }
      if (request.method === 'POST') {
        connection = {
          ...makeConnection(
            'PENDING',
            typeof body?.serverKey === 'string' ? body.serverKey : 'github',
          ),
          configId: body.configId,
        };
        send(200, browserSignIn());
        return;
      }
      // Disconnecting a listed curated connection by its id leaves the GitHub
      // one alone.
      const deletingExtra = extras.findIndex((entry) =>
        url.pathname.includes(entry.id),
      );
      if (request.method === 'DELETE' && deletingExtra >= 0) {
        extras[deletingExtra] = {
          ...extras[deletingExtra],
          status: 'DISCONNECTED',
        };
        send(200, { ok: true });
        return;
      }
      if (request.method === 'DELETE') {
        connection = { ...connection, status: 'DISCONNECTED' };
        send(200, { ok: true });
        return;
      }
      if (request.method === 'PATCH') {
        connection = { ...connection, enabledTools: body.enabledTools };
        send(200, { connection });
        return;
      }
      if (url.pathname.endsWith('/mcp-connections')) {
        if (listFailure === 'offline') {
          request.socket.destroy();
          return;
        }
        if (typeof listFailure === 'number') {
          send(listFailure, { error: 'unavailable' });
          return;
        }
        send(200, {
          connections: [connection, ...extras, ...customs].filter(Boolean),
        });
        return;
      }
      const extra = extras.find((entry) => url.pathname.includes(entry.id));
      const target = customIndex >= 0 ? custom : (extra ?? connection);
      send(
        target ? 200 : 404,
        target ? { connection: target } : { error: 'not_found' },
      );
      return;
    }
    if (await handleCloudRequest(request, response, url)) return;
    send(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    externalOpenUrl: `${baseUrl}/external-open`,
    calls,
    authLinks,
    catalogRequests,
    setCatalogOffline(value) {
      catalogOffline = value;
    },
    externalOpens,
    customs,
    /** Keeps cancellation in flight until the returned release is called. */
    holdDisconnect() {
      disconnectWait = new Promise((resolve) => {
        releaseDisconnect = resolve;
      });
      return () => {
        releaseDisconnect?.();
        disconnectWait = undefined;
      };
    },
    /** How many times the curated MCP catalog was read. */
    get curatedReads() {
      return curatedReads;
    },
    /** Finishes every sign-in, or only the one for `serverKey`. */
    complete(serverKey) {
      if (connection && (!serverKey || connection.serverKey === serverKey))
        connection = { ...connection, status: 'CONNECTED' };
      for (const [index, entry] of extras.entries())
        if (!serverKey || entry.serverKey === serverKey)
          extras[index] = { ...entry, status: 'CONNECTED' };
      for (const [index, entry] of customs.entries())
        if (!serverKey || entry.serverKey === serverKey)
          customs[index] = { ...entry, status: 'CONNECTED' };
    },
    /**
     * Fails only the named provider's pending sign-in the way a rejected
     * token exchange does: REAUTH_REQUIRED with the exchange's code.
     */
    fail(serverKey) {
      updatePending(serverKey, {
        status: 'REAUTH_REQUIRED',
        lastError: 'invalid_grant',
      });
    },
    /**
     * The provider's answer to the next sign-in page the browser opens for
     * `serverKey`: an OAuth `error` such as `access_denied`, or null for none.
     */
    answerSignIn(serverKey, error) {
      signInAnswer = error ? { serverKey, error } : null;
    },
    async close() {
      releaseDisconnect?.();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
