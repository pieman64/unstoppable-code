import http from 'node:http';

/**
 * Receives the E2E build's external opens. `openExternalGuarded` never
 * reaches `shell.openExternal` in E2E builds; it POSTs `{ url }` to
 * `CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL` instead, so patching `shell` from a
 * spec observes nothing. Pass `env` to `launchCanopy` and read `opened`.
 */
export async function startExternalOpenCapture() {
  const opened = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // The caller's assertion reports malformed or missing requests.
      }
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A spec whose launch throws before its `finally` never closes this server;
  // unref keeps a leaked listener from holding the worker process open.
  server.unref();
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('External-open capture server did not bind a TCP port.');
  }
  const url = `http://127.0.0.1:${address.port}/external-open`;
  return {
    env: { CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: url },
    opened,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  };
}
