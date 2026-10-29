// Keeps one failing mock route from terminating the shared mock server.
//
// The server runs once for the whole Playwright suite (see ./start.mjs), and
// Playwright does not restart it. An unhandled rejection from a single route
// would otherwise exit the process and fail every later test in the shard.

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wrap an async request handler so a synchronous throw or rejected promise
 * answers 500 (or closes a response whose headers are already sent) instead
 * of escaping as an unhandled rejection.
 *
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => unknown} handler
 * @param {(...args: unknown[]) => void} [log]
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void}
 */
export function guardRequestHandler(handler, log = console.error) {
  return (request, response) => {
    Promise.resolve()
      .then(() => handler(request, response))
      .catch((error) => {
        try {
          const failed = `[mock-server] ${request.method} ${request.url} failed`;
          if (response.writableEnded) {
            log(`${failed} after its response ended:`, error);
            return;
          }
          if (response.headersSent) {
            log(`${failed} after sending headers; closing it:`, error);
            response.destroy();
            return;
          }
          log(`${failed}; answering 500:`, error);
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: `Mock server route failed: ${describeError(error)}`,
            }),
          );
        } catch {
          // Recovery itself failed; close this request without losing the server.
          response.destroy();
        }
      });
  };
}
