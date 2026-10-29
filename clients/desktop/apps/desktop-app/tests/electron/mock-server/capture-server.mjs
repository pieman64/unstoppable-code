// Dedicated outbound-capture listener for provider isolation probes
// (managed browser delegation S0.1, promoted as Phase A item 4).
//
// A capture server is a separate loopback listener that answers exactly like
// the shared mock's LLM surface and records every request and WebSocket
// message it receives (see ./outbound-capture.mjs for the evidence model).
// Recording is opt-in: nothing starts on import, ./start.mjs does not use this
// module, the shared suite server records nothing, and evidence is available
// only in-process through `capture`. No route exposes evidence or accepts
// control commands; `/__mock/*`, `/healthz` and every other non-LLM path is a
// recorded 404. Register scripted conversations in-process with
// `registerScenario` from ./control-plane.mjs, which this listener shares with
// routes/llm.mjs.
//
// Replies reuse the pinned mock modules without edits:
// - HTTP requests go to `handleLlmRequest` (routes/llm.mjs), which receives the
//   exact body bytes through a PassThrough. The recorder reads the original
//   request, so its byte caps never truncate what the mock sees.
// - WebSocket upgrades to `/responses` and `/v1/responses` mirror
//   routes/responsesWs.mjs: JSON `response.create` messages are answered with
//   `resolveResponsesReply`, `classifyResponsesStepError` and
//   `buildResponsesEvents`, paced by `streamMs` the same way; any other message
//   is recorded and ignored.
//
// Deliberate differences from the shared mock, none of which change a reply
// the shared mock would send:
// - An upgrade to any other path is recorded and refused with 404 instead of
//   being left open.
// - If the scripted resolver throws (routes/llm.mjs does so for input items
//   such as `null`), the shared server would crash with an unhandled
//   rejection. Here the request gets a 500, or the socket closes with 1011,
//   and a `handler-error` diagnostic is recorded.
// - A request Node cannot parse and a frame the WebSocket layer rejects are
//   recorded as `malformed` items before their socket closes.
//
// Usage (the caller owns `listen`):
//
//   import { createCaptureServer } from './mock-server/capture-server.mjs';
//   import { registerScenario } from './mock-server/control-plane.mjs';
//
//   const { server, capture, close } = createCaptureServer({
//     maxBodyBytes: 4 * 1024 * 1024, // per body or message (default)
//     maxRecords: 1000, // per window (default)
//     maxTotalBytes: 64 * 1024 * 1024, // per window (default)
//     maxDiagnostics: 100, // per window (default)
//   });
//   await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
//   const base = `http://127.0.0.1:${server.address().port}`;
//   try {
//     registerScenario('Canopy-C123', { llm: { steps: [...] } });
//     // Claude: ANTHROPIC_BASE_URL=base. Codex: a provider base_url of
//     // `${base}/v1` (HTTP `/v1/responses` or WebSocket `/v1/responses`).
//     capture.assertCanaryPresent('TOOL_RESULT_CANARY_1', { toolResult: true });
//     capture.assertCanaryAbsent(['PROJECT_AGENTS_CANARY_1']);
//     await writeFile(evidencePath, JSON.stringify(capture.snapshot()));
//   } finally {
//     await close();
//   }
//
// `close()` is idempotent and resolves after the listener stopped: it clears
// this module's pacing timers, terminates WebSocket clients, destroys every
// socket, and finalizes in-flight requests as `aborted` (`server-closed`).
// `capture` stays readable afterwards. SSE pacing timers inside routes/llm.mjs
// (only for HTTP steps with `streamMs`) cannot be cancelled without editing
// that pinned module; their late writes go to destroyed responses and are
// dropped.

import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildResponsesEvents,
  classifyResponsesStepError,
  handleLlmRequest,
  normalizeLlmProxyPath,
  resolveResponsesReply,
} from './routes/llm.mjs';
import {
  CAPTURE_SURFACES,
  createOutboundCapture,
} from './outbound-capture.mjs';

// Mirrors RESPONSES_WS_PATHS in routes/responsesWs.mjs.
const RESPONSES_WS_PATHS = new Set(['/responses', '/v1/responses']);

// Mirrors the route table in `handleLlmRequest`.
const POST_SURFACES = new Map([
  ['/v1/messages', CAPTURE_SURFACES.anthropicMessages],
  ['/v1/messages/count_tokens', CAPTURE_SURFACES.anthropicCountTokens],
  ['/v1/responses', CAPTURE_SURFACES.openAiResponses],
  ['/v1/chat/completions', CAPTURE_SURFACES.openAiChatCompletions],
]);

const UPGRADE_NOT_FOUND =
  'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Create a dedicated capture listener. It is not listening yet: call
 * `server.listen(0, '127.0.0.1', callback)`.
 *
 * @param {Partial<import('./outbound-capture.mjs').CaptureLimits>} [options]
 *   Recorder limits: `maxBodyBytes`, `maxRecords`, `maxTotalBytes` and
 *   `maxDiagnostics`, each a positive safe integer. Defaults are
 *   `DEFAULT_CAPTURE_LIMITS` in ./outbound-capture.mjs; unknown keys throw.
 * @returns {{
 *   server: import('node:http').Server,
 *   capture: import('./outbound-capture.mjs').OutboundCapture,
 *   close: () => Promise<void>,
 * }}
 */
export function createCaptureServer(options = {}) {
  const { capture, sink } = createOutboundCapture(options);
  const sockets = new Set();
  const inflight = new Set();
  const pendingBySocket = new Map();
  const sleepers = new Set();
  const wss = new WebSocketServer({ noServer: true });
  let closed = false;
  let closing;

  const server = createServer((request, response) => {
    handleRequest(request, response);
  });

  server.on('connection', (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  // Registering this listener replaces Node's default reply, so the socket is
  // always destroyed here. A client that stops mid-body reports its error here
  // before the request aborts; attribute it to that request, not a new item.
  server.on('clientError', (error, socket) => {
    const code = errorCode(error);
    const item = pendingBySocket.get(socket);
    if (item) {
      item.abort(code);
    } else if (code.startsWith('HPE_') || code === 'ERR_HTTP_REQUEST_TIMEOUT') {
      sink.recordMalformedRequest({ code });
    }
    socket.destroy();
  });

  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head);
  });

  function handleRequest(request, response) {
    const target = parseTarget(request.url);
    const socket = request.socket;
    const item = sink.beginHttp({
      method: request.method,
      path: target.path,
      queryKeys: target.queryKeys,
      contentEncoding: headerValue(request.headers['content-encoding']),
      surface: target.url
        ? httpSurface(request.method, target.url.pathname)
        : null,
    });

    // routes/llm.mjs reads the body from the stream it is given. The recorder
    // listens to the original request, and the mock reads an identical copy.
    const forward = new PassThrough();
    forward.method = request.method;
    forward.url = request.url;
    forward.headers = request.headers;
    // The mock resolves `{}` on a stream error; never let one escape.
    forward.on('error', () => {});

    let open = true;
    const tracked = {
      abort(code) {
        if (!settle()) return;
        item.abort(code);
        forward.destroy(new Error(`Request body ended early (${code})`));
      },
    };
    function settle() {
      if (!open) return false;
      open = false;
      inflight.delete(tracked);
      if (pendingBySocket.get(socket) === tracked)
        pendingBySocket.delete(socket);
      return true;
    }
    // clientError and close() reach an unfinished body through these.
    inflight.add(tracked);
    pendingBySocket.set(socket, tracked);

    request.on('data', (chunk) => item.push(chunk));
    request.once('end', () => {
      if (settle()) item.end();
    });
    request.on('error', (error) => tracked.abort(errorCode(error)));
    request.once('close', () => tracked.abort('closed'));
    request.pipe(forward);

    const handling = target.url
      ? handleLlmRequest(forward, response, target.url)
      : Promise.resolve(false);
    handling
      .then(
        async (handled) => {
          // Drain a body the mock did not read (GET /v1/models, unrouted
          // paths) so the record completes.
          forward.resume();
          if (handled) {
            item.setOutcome(true, sentStatus(response));
            return;
          }
          item.setOutcome(false, null);
          const outcome = await item.settled;
          if (
            outcome !== 'done' ||
            response.headersSent ||
            response.destroyed
          ) {
            return;
          }
          // Same fallback as ./start.mjs.
          jsonResponse(response, 404, {
            error: `Unhandled mock route: ${target.path}`,
          });
          item.setOutcome(false, 404);
        },
        (error) => {
          forward.resume();
          item.noteError(errorCode(error));
          if (response.headersSent || response.destroyed) {
            item.setOutcome(false, sentStatus(response));
            response.destroy();
            return;
          }
          jsonResponse(response, 500, {
            error: 'Capture mock handler failed.',
          });
          item.setOutcome(false, 500);
        },
      )
      .catch((error) => {
        item.noteError(errorCode(error));
        response.destroy();
      });
  }

  function handleUpgrade(request, socket, head) {
    const target = parseTarget(request.url);
    const responses =
      target.url !== null && RESPONSES_WS_PATHS.has(target.url.pathname);
    const upgrade = sink.recordUpgrade({
      method: request.method,
      path: target.path,
      queryKeys: target.queryKeys,
      surface: responses ? CAPTURE_SURFACES.openAiResponses : null,
    });
    socket.on('error', () => {});
    if (closed || !responses) {
      upgrade.reject(head.length);
      if (closed) {
        socket.destroy();
        return;
      }
      socket.once('finish', () => socket.destroy());
      socket.end(UPGRADE_NOT_FOUND);
      return;
    }
    let opened = false;
    // ws refuses an invalid handshake itself and closes the socket.
    socket.once('close', () => {
      if (!opened) upgrade.reject(head.length);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      opened = true;
      upgrade.accept();
      attachResponsesSocket(ws, upgrade.connection);
    });
  }

  function attachResponsesSocket(ws, connection) {
    let frame = 0;
    ws.on('message', (data, isBinary) => {
      frame += 1;
      const bytes = toBuffer(data);
      const item = sink.recordMessage({
        connection,
        frame,
        binary: isBinary,
        data: bytes,
        surface: CAPTURE_SURFACES.openAiResponses,
      });
      // Same acceptance rule as routes/responsesWs.mjs.
      let body;
      try {
        body = JSON.parse(bytes.toString());
      } catch {
        item.setReply('ignored');
        return;
      }
      if (body?.type !== 'response.create') {
        item.setReply('ignored');
        return;
      }
      void answerResponseCreate(ws, body, item);
    });
    ws.on('error', (error) => {
      // routes/responsesWs.mjs swallows socket errors. A protocol error also
      // discards the frame that caused it, so account for that frame.
      const code = errorCode(error);
      if (!code.startsWith('WS_ERR_')) return;
      frame += 1;
      sink.recordMessageError({
        connection,
        frame,
        code,
        surface: CAPTURE_SURFACES.openAiResponses,
      });
    });
  }

  // Mirrors `handleResponseCreate` in routes/responsesWs.mjs, with pacing
  // timers that close() can cancel.
  async function answerResponseCreate(ws, body, item) {
    try {
      const { step, usage, model } = resolveResponsesReply(body);
      const failure = classifyResponsesStepError(step);
      if (failure) {
        const id = `resp_mock_${Date.now()}`;
        item.setReply('failed', id);
        send(ws, {
          type: 'response.failed',
          response: {
            id,
            object: 'response',
            status: 'failed',
            error: { code: failure.code, message: failure.message },
          },
        });
        return;
      }
      const events = buildResponsesEvents(step, usage, model);
      item.setReply('response', events[0]?.data?.response?.id);
      const pacedCount = events.filter((entry) => entry.paced).length;
      const totalMs =
        typeof step.streamMs === 'number' && step.streamMs > 0
          ? step.streamMs
          : 0;
      const perChunkMs =
        totalMs > 0 && pacedCount > 0 ? totalMs / pacedCount : 0;
      for (const entry of events) {
        if (closed) return;
        send(ws, entry.data);
        if (entry.paced && perChunkMs > 0) await sleep(perChunkMs);
      }
    } catch (error) {
      item.setReply('error');
      item.noteError(errorCode(error));
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, 'Capture mock handler failed');
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      const sleeper = { resolve, timer: undefined };
      sleeper.timer = setTimeout(() => {
        sleepers.delete(sleeper);
        resolve();
      }, ms);
      sleepers.add(sleeper);
    });
  }

  async function shutdown() {
    for (const sleeper of sleepers) {
      clearTimeout(sleeper.timer);
      sleeper.resolve();
    }
    sleepers.clear();
    const stopped = new Promise((resolve) => {
      // Called with ERR_SERVER_NOT_RUNNING when listen() never ran; either
      // way nothing is listening afterwards.
      server.close(() => resolve());
    });
    for (const client of wss.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    for (const item of [...inflight]) item.abort('server-closed');
    await stopped;
    await new Promise((resolve) => {
      wss.close(() => resolve());
    });
  }

  function close() {
    if (!closing) {
      closed = true;
      closing = shutdown();
    }
    return closing;
  }

  return { server, capture, close };
}

function parseTarget(rawUrl) {
  try {
    const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
    return {
      url,
      path: url.pathname,
      queryKeys: [...new Set(url.searchParams.keys())],
    };
  } catch {
    const raw = String(rawUrl ?? '');
    const queryStart = raw.indexOf('?');
    return {
      url: null,
      path: queryStart === -1 ? raw : raw.slice(0, queryStart),
      queryKeys: [],
    };
  }
}

function httpSurface(method, pathname) {
  const route = normalizeLlmProxyPath(pathname).pathname;
  if (method === 'GET' && route === '/v1/models') {
    return CAPTURE_SURFACES.models;
  }
  if (method !== 'POST') return null;
  return POST_SURFACES.get(route) ?? null;
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : null;
}

function sentStatus(response) {
  return response.headersSent ? response.statusCode : null;
}

function jsonResponse(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function errorCode(error) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code;
  if (typeof error?.name === 'string' && error.name !== '') return error.name;
  return 'unknown';
}
