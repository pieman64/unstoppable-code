// WebSocket transport for the OpenAI Responses API (`responses_websockets`
// beta). Bundled Codex (0.138+) no longer speaks the Chat Completions wire and
// drives the Responses API over a WebSocket: it dials `ws://<base>/responses`,
// sends a `response.create` frame, and consumes streamed `response.*` events.
// The HTTP-only `/v1/responses` route therefore never sees Codex traffic, so
// the Codex-backed helper/pipeline flows (e.g. branch naming) need this socket.
//
// The frames reuse the exact `response.*` event objects the SSE renderer emits
// (`buildResponsesEvents` in ./llm.mjs); only the framing differs. Each event is
// sent as its own top-level JSON text frame, and the terminal `response.completed`
// (carrying the final `output` items + usage) ends the turn — verified against
// the bundled Codex 0.138 client, which surfaces the streamed message as an
// `item.completed` / `agent_message` SDK event.
import { WebSocket, WebSocketServer } from 'ws';
import {
  buildResponsesEvents,
  classifyResponsesStepError,
  resolveResponsesReply,
} from './llm.mjs';

const RESPONSES_WS_PATHS = new Set(['/responses', '/v1/responses']);

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function handleResponseCreate(ws, body) {
  const { step, usage, model } = resolveResponsesReply(body);

  const error = classifyResponsesStepError(step);
  if (error) {
    send(ws, {
      type: 'response.failed',
      response: {
        id: `resp_mock_${Date.now()}`,
        object: 'response',
        status: 'failed',
        error: { code: error.code, message: error.message },
      },
    });
    return;
  }

  const events = buildResponsesEvents(step, usage, model);
  const pacedCount = events.filter((e) => e.paced).length;
  const totalMs =
    typeof step.streamMs === 'number' && step.streamMs > 0 ? step.streamMs : 0;
  const perChunkMs = totalMs > 0 && pacedCount > 0 ? totalMs / pacedCount : 0;

  // Stream the `response.*` events as top-level frames, exactly as the SSE
  // transport emits them. The terminal `response.completed` (last entry) carries
  // the final `output` items + usage and signals end-of-turn for this
  // `response.create`.
  for (const entry of events) {
    send(ws, entry.data);
    if (entry.paced && perChunkMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, perChunkMs));
    }
  }
}

export function attachResponsesWebSocket(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      pathname = request.url ?? '/';
    }
    if (!RESPONSES_WS_PATHS.has(pathname)) {
      // Not ours — let any other upgrade handler (or the default) deal with it.
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => {
        let body;
        try {
          body = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (body?.type !== 'response.create') {
          return;
        }
        void handleResponseCreate(ws, body);
      });
      ws.on('error', () => {
        // Swallow — a dropped Codex prewarm/turn socket is not a mock failure.
      });
    });
  });

  return wss;
}
