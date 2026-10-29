// A loopback pass-through between the Codex app-server and the capture
// listener, used only by the follow-up probe.
//
// Why it exists: the shared mock can only script `function_call` items, but
// the pinned Codex advertises its code-mode wrapper (`exec`) as a *custom*
// (freeform) tool whose calls are `custom_tool_call` items. To attempt
// `exec` natively the probe scripts a marked function_call and this layer
// turns exactly that item into a custom_tool_call on the way back to Codex.
//
// Scope and limits:
// - Requests are forwarded byte for byte. The capture listener behind this
//   layer therefore records exactly what Codex sent (the tests assert this).
// - Only server-to-client Responses output items are touched, and only a
//   `function_call` for a listed tool whose arguments are exactly
//   `{ "__custom_input": "<text>" }`. Everything else passes unchanged.
// - WebSocket upgrades are tunnelled raw, not rewritten (counted in
//   `stats.upgrades` so an unrewritable transport is visible, never assumed).
// - It adds no authentication, no model proxying and no non-loopback traffic.
import { request as httpRequest, createServer } from 'node:http';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export const CUSTOM_INPUT_KEY = '__custom_input';

function rewriteItem(item, toolNames) {
  if (
    item?.type !== 'function_call' ||
    !toolNames.includes(item.name) ||
    typeof item.arguments !== 'string'
  )
    return null;
  let parsed;
  try {
    parsed = JSON.parse(item.arguments);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed[CUSTOM_INPUT_KEY] !== 'string'
  )
    return null;
  return {
    id: item.id,
    type: 'custom_tool_call',
    name: item.name,
    ...(item.namespace ? { namespace: item.namespace } : {}),
    call_id: item.call_id,
    input: parsed[CUSTOM_INPUT_KEY],
  };
}

/**
 * Rewrite one parsed Responses event. Returns the (possibly new) event and
 * the number of items converted. Never mutates the input.
 */
export function rewriteResponsesEvent(event, { toolNames }) {
  if (event === null || typeof event !== 'object')
    return { event, rewritten: 0 };
  if (
    (event.type === 'response.output_item.done' ||
      event.type === 'response.output_item.added') &&
    event.item
  ) {
    const replacement = rewriteItem(event.item, toolNames);
    return replacement
      ? { event: { ...event, item: replacement }, rewritten: 1 }
      : { event, rewritten: 0 };
  }
  if (event.object === 'response' && Array.isArray(event.output)) {
    // A non-streaming reply is the response object itself.
    const inner = rewriteResponsesEvent({ response: event }, { toolNames });
    return inner.rewritten > 0
      ? { event: inner.event.response, rewritten: inner.rewritten }
      : { event, rewritten: 0 };
  }
  if (Array.isArray(event.response?.output)) {
    let rewritten = 0;
    const output = event.response.output.map((item) => {
      const replacement = rewriteItem(item, toolNames);
      if (!replacement) return item;
      rewritten += 1;
      return replacement;
    });
    return rewritten > 0
      ? {
          event: { ...event, response: { ...event.response, output } },
          rewritten,
        }
      : { event, rewritten: 0 };
  }
  return { event, rewritten: 0 };
}

/** Incremental SSE transformer (text in, text out), safe at any chunk split. */
export function createSseRewriter({ toolNames }) {
  const stats = { frames: 0, rewrittenItems: 0, unparsedFrames: 0 };
  let buffer = '';
  const processFrame = (frame) => {
    stats.frames += 1;
    const lines = frame.split('\n');
    const index = lines.findIndex((line) => line.startsWith('data: '));
    if (index < 0) return frame;
    const payload = lines[index].slice(6);
    if (payload === '[DONE]') return frame;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      stats.unparsedFrames += 1;
      return frame;
    }
    const result = rewriteResponsesEvent(event, { toolNames });
    if (result.rewritten === 0) return frame;
    stats.rewrittenItems += result.rewritten;
    lines[index] = `data: ${JSON.stringify(result.event)}`;
    return lines.join('\n');
  };
  return {
    stats,
    push(chunk) {
      buffer += chunk;
      let out = '';
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        out += `${processFrame(buffer.slice(0, boundary))}\n\n`;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
      return out;
    },
    end() {
      const rest = buffer;
      buffer = '';
      return rest;
    },
  };
}

/**
 * @param {{ upstreamPort: number, upstreamHost?: string, toolNames?: string[] }} options
 * @returns {{ server: import('node:http').Server, stats: object, close: () => Promise<void> }}
 */
export function createCustomCallRewriter({
  upstreamPort,
  upstreamHost = '127.0.0.1',
  toolNames = ['exec'],
}) {
  const stats = {
    requests: 0,
    requestBodyBytes: 0,
    upgrades: 0,
    rewrittenItems: 0,
    unparsedFrames: 0,
    upstreamErrors: 0,
  };
  const sockets = new Set();
  const server = createServer((req, res) => {
    stats.requests += 1;
    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (upstreamRes) => {
        const type = String(upstreamRes.headers['content-type'] ?? '');
        const headers = { ...upstreamRes.headers };
        delete headers['transfer-encoding'];
        if (type.includes('text/event-stream')) {
          delete headers['content-length'];
          res.writeHead(upstreamRes.statusCode ?? 502, headers);
          const rewriter = createSseRewriter({ toolNames });
          const decoder = new StringDecoder('utf8');
          const settle = () => {
            stats.rewrittenItems += rewriter.stats.rewrittenItems;
            stats.unparsedFrames += rewriter.stats.unparsedFrames;
          };
          upstreamRes.on('data', (chunk) => {
            const out = rewriter.push(decoder.write(chunk));
            if (out) res.write(out);
          });
          upstreamRes.on('end', () => {
            const rest = rewriter.end() + decoder.end();
            if (rest) res.write(rest);
            settle();
            res.end();
          });
          upstreamRes.on('error', () => res.destroy());
          return;
        }
        if (type.includes('application/json')) {
          const chunks = [];
          upstreamRes.on('data', (chunk) => chunks.push(chunk));
          upstreamRes.on('end', () => {
            const raw = Buffer.concat(chunks);
            let body = raw;
            try {
              const result = rewriteResponsesEvent(
                JSON.parse(raw.toString('utf8')),
                { toolNames },
              );
              if (result.rewritten > 0) {
                stats.rewrittenItems += result.rewritten;
                body = Buffer.from(JSON.stringify(result.event));
              }
            } catch {
              // Not JSON after all: forward the original bytes.
            }
            headers['content-length'] = String(body.length);
            res.writeHead(upstreamRes.statusCode ?? 502, headers);
            res.end(body);
          });
          upstreamRes.on('error', () => res.destroy());
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      stats.upstreamErrors += 1;
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('data', (chunk) => {
      stats.requestBodyBytes += chunk.length;
    });
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket, head) => {
    stats.upgrades += 1;
    const tunnel = net.connect(upstreamPort, upstreamHost, () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let index = 0; index < req.rawHeaders.length; index += 2)
        raw += `${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}\r\n`;
      tunnel.write(`${raw}\r\n`);
      if (head.length > 0) tunnel.write(head);
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    });
    sockets.add(tunnel);
    tunnel.once('close', () => sockets.delete(tunnel));
    tunnel.on('error', () => socket.destroy());
    socket.on('error', () => tunnel.destroy());
  });
  return {
    server,
    stats,
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening)
        await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
