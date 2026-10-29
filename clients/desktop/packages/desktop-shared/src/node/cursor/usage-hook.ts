import {
  parseCursorReportedUsage,
  type CursorReportedUsage,
} from '@canopy/agent-transcript/lib/cursor-usage';
import {
  createCursorHookTransport,
  type CursorHookTransport,
} from './hook-transport';

/** A separate callback and credential: usage reports never authorize tools. */
export async function createCursorUsageHook(
  getSessionId: () => string | undefined,
  report: (usage: CursorReportedUsage) => void | Promise<void>,
): Promise<CursorHookTransport> {
  return createCursorHookTransport(
    async (payload) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !('hook_event_name' in payload) ||
        payload.hook_event_name !== 'afterAgentResponse' ||
        !('conversation_id' in payload) ||
        typeof payload.conversation_id !== 'string' ||
        !payload.conversation_id ||
        payload.conversation_id !== getSessionId()
      )
        return Promise.resolve({ decision: 'deny' });
      const usage = parseCursorReportedUsage({
        inputTokens:
          'input_tokens' in payload ? payload.input_tokens : undefined,
        outputTokens:
          'output_tokens' in payload ? payload.output_tokens : undefined,
        cacheReadTokens:
          'cache_read_tokens' in payload
            ? payload.cache_read_tokens
            : undefined,
        cacheWriteTokens:
          'cache_write_tokens' in payload
            ? payload.cache_write_tokens
            : undefined,
      });
      if (!usage) return Promise.resolve({ decision: 'deny' });
      await report(usage);
      return { decision: 'allow' };
    },
    () => {},
    { maxRequestBytes: 64 * 1024 },
  );
}

/**
 * Strip response text before transport; unavailable telemetry never stops a
 * turn. Tolerates the UTF-8 byte-order mark the Cursor runtime on Windows
 * writes before the JSON.
 */
export const CURSOR_USAGE_HOOK_SCRIPT = String.raw`
const http = require('node:http');
const fs = require('node:fs');
let done = false;
function finish() {
  if (done) return;
  done = true;
  process.stdout.write('{}\n', () => process.exit(0));
}
process.on('uncaughtException', finish);
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chunks = [];
let bytes = 0;
process.stdin.on('data', chunk => {
  bytes += chunk.length;
  if (bytes > 8 * 1024 * 1024) return finish();
  chunks.push(chunk);
});
process.stdin.on('error', finish);
process.stdin.on('end', () => {
  if (done) return;
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    const payload = {};
    for (const key of ['hook_event_name', 'conversation_id', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) payload[key] = input[key];
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 65536) return finish();
    const request = http.request(config.url, { method:'POST', headers:{ authorization:'Bearer ' + config.token, 'content-type':'application/json' } }, response => {
      response.resume();
      response.on('error', finish);
      response.on('end', finish);
    });
    request.on('error', finish);
    request.setTimeout(1000, () => { request.destroy(); finish(); });
    request.end(body);
  } catch { finish(); }
});
setTimeout(finish, 2000).unref();
`;
