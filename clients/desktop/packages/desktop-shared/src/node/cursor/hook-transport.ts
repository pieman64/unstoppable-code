import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

// The pinned CLI sends a Write's whole post-edit file as its hook input, so
// allow large files while bounding the complete UTF-8 JSON request, including
// metadata and escaping overhead, independently from the small response.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface CursorHookResponseOptions {
  status?: number;
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export interface CursorHookTransport {
  url: string;
  token: string;
  revoke(): void;
  close(): Promise<void>;
}

export interface CursorHookDecision {
  decision: 'allow' | 'deny';
  message?: string;
  stopTurn?: boolean;
}

/** Approval outcome plus an optional rewritten tool input, forwarded only on allow. */
export interface CursorHookOutcome extends CursorHookDecision {
  updatedInput?: Record<string, unknown>;
}

/** Authenticated, bounded callback transport. Policy is owned by the caller. */
export async function createCursorHookTransport(
  authorize: (payload: unknown) => Promise<CursorHookOutcome>,
  onRevoke: () => void,
  {
    maxRequestBytes = MAX_REQUEST_BYTES,
    rejectOversizedRewrites = false,
  }: { maxRequestBytes?: number; rejectOversizedRewrites?: boolean } = {},
): Promise<CursorHookTransport> {
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let active = true;
  let generation = 0;
  let inFlight = 0;

  function revoke(): void {
    if (!active) return;
    active = false;
    generation += 1;
    onRevoke();
  }

  function respond(
    res: ServerResponse,
    permission: 'allow' | 'deny',
    options: CursorHookResponseOptions = {},
  ): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(options.status ?? 200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    const fallbackBody = {
      permission,
      ...(permission === 'deny'
        ? {
            agent_message:
              'The host rejected this operation. Do not retry it through another tool.',
          }
        : {}),
    };
    const body =
      permission === 'allow' && options.updatedInput
        ? { ...fallbackBody, updated_input: options.updatedInput }
        : permission === 'deny' && options.message?.trim()
          ? {
              ...fallbackBody,
              user_message: options.message.slice(0, 4096),
              agent_message: `${options.message.slice(0, 4096)} Do not retry it through another tool.`,
            }
          : fallbackBody;
    const serialized = JSON.stringify(body);
    res.end(
      Buffer.byteLength(serialized) <= MAX_RESPONSE_BYTES
        ? serialized
        : JSON.stringify(
            rejectOversizedRewrites && options.updatedInput
              ? {
                  permission: 'deny',
                  agent_message:
                    'The approved tool arguments exceed the response limit. Do not retry with the original arguments.',
                }
              : fallbackBody,
          ),
    );
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (
      req.method !== 'POST' ||
      req.url !== '/hook' ||
      req.headers.origin !== undefined ||
      auth.length !== expectedAuth.length ||
      !timingSafeEqual(auth, expectedAuth)
    ) {
      respond(res, 'deny', { status: 403 });
      return;
    }
    if (!active || inFlight >= 8) {
      respond(res, 'deny');
      return;
    }
    inFlight += 1;
    const requestGeneration = generation;
    const onClose = (): void => {
      if (!res.writableFinished) revoke();
    };
    res.once('close', onClose);
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) {
          respond(res, 'deny');
          return;
        }
        bytes += chunk.length;
        if (bytes > maxRequestBytes) {
          // Drain without retaining an oversized body. Returning from the
          // iterator destroys the socket before its denial can flush. The
          // request timeout and connection bound still apply while draining.
          chunks.length = 0;
          continue;
        }
        chunks.push(chunk);
      }
      if (bytes > maxRequestBytes) {
        respond(res, 'deny', { status: 413 });
        return;
      }
      // The Cursor runtime on Windows prefixes hook stdin with a UTF-8
      // byte-order mark, which strict JSON parsing rejects. The standalone
      // hook drops it too; this covers a hook script that forwards it.
      const payload: unknown = JSON.parse(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/^\uFEFF/, ''),
      );
      if (!active || requestGeneration !== generation) {
        respond(res, 'deny');
        return;
      }
      const decision = await authorize(payload);
      if (decision.stopTurn) revoke();
      const permission =
        active &&
        generation === requestGeneration &&
        decision.decision === 'allow'
          ? 'allow'
          : 'deny';
      respond(res, permission, {
        updatedInput: decision.updatedInput,
        ...(decision.decision === 'deny' ? { message: decision.message } : {}),
      });
    } catch {
      respond(res, 'deny');
    } finally {
      inFlight -= 1;
      res.off('close', onClose);
    }
  }

  const server = createServer((req, res): void => {
    void handle(req, res);
  });
  server.requestTimeout = 70_000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local approval callback.');
  }
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    token,
    revoke,
    close: (): Promise<void> => {
      closing ??= new Promise<void>((resolveClose) => {
        revoke();
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/**
 * Standalone Node hook; all failures produce an explicit denial. An allow may
 * carry the host's rewritten `updated_input`, which the CLI applies before
 * executing the tool. A leading UTF-8 byte-order mark, which the Cursor
 * runtime on Windows writes before the JSON, is dropped before forwarding.
 */
export const CURSOR_HOOK_SCRIPT = String.raw`
const http = require('node:http');
const fs = require('node:fs');
let done = false;
const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
function finish(permission, updatedInput, rejection) {
  if (done) return;
  done = true;
  const output = permission === 'allow' && isPlainObject(updatedInput)
    ? {permission, updated_input: updatedInput}
    : {permission};
  if (permission === 'deny' && isPlainObject(rejection) && typeof rejection.user_message === 'string') {
    output.user_message = rejection.user_message.slice(0, 4096);
    if (typeof rejection.agent_message === 'string') output.agent_message = rejection.agent_message.slice(0, 8192);
  }
  process.stdout.write(JSON.stringify(output) + '\n', () => process.exit(0));
}
process.on('uncaughtException', () => finish('deny'));
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chunks = [];
let bytes = 0;
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > ${MAX_REQUEST_BYTES}) return finish('deny');
  chunks.push(chunk);
});
process.stdin.on('error', () => finish('deny'));
process.stdin.on('end', () => {
  if (done) return;
  const request = http.request(config.url, {method:'POST', headers:{authorization:'Bearer ' + config.token, 'content-type':'application/json'}}, response => {
    let body = '';
    response.on('data', chunk => {body += chunk.toString(); if(body.length > ${MAX_RESPONSE_BYTES}) finish('deny');});
    response.on('error', () => finish('deny'));
    response.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (response.statusCode === 200 && isPlainObject(parsed) && parsed.permission === 'allow') finish('allow', parsed.updated_input);
        else finish('deny', undefined, response.statusCode === 200 ? parsed : undefined);
      }
      catch {finish('deny');}
    });
  });
  request.on('error', () => finish('deny'));
  request.setTimeout(70000, () => {request.destroy(); finish('deny');});
  const input = Buffer.concat(chunks);
  request.end(input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? input.subarray(3) : input);
});
setTimeout(() => finish('deny'), 72000).unref();
`;
