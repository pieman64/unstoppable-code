/** @jest-environment node */
import { createReleaseNotesReader } from '../index';
const feed = {
  schemaVersion: 1,
  entries: [
    {
      version: '1.9.0',
      releasedOn: '2026-10-14',
      highlights: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
    },
  ],
};
const url = 'https://example.test/release-notes.json';
test('coalesces reads and refreshes after cache expiration without credentials', async () => {
  let now = 0;
  const fetchImpl = jest.fn(() => Promise.resolve(Response.json(feed)));
  const read = createReleaseNotesReader({ fetchImpl, now: () => now });
  expect(await Promise.all([read(url), read(url)])).toEqual([feed, feed]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    }),
  );
  now = 60_001;
  await read(url);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});
test('fails quietly for unavailable, malformed, unpublished and oversized feeds; retries failures', async () => {
  let now = 0;
  const fetchImpl = jest.fn(() =>
    Promise.resolve(new Response('', { status: 503 })),
  );
  const read = createReleaseNotesReader({ fetchImpl, now: () => now });
  expect(await read(url)).toBeNull();
  fetchImpl.mockImplementation(() => Promise.resolve(Response.json(feed)));
  now = 5001;
  expect(await read(url)).toEqual(feed);
  for (const body of [
    'invalid',
    JSON.stringify({ ...feed, schemaVersion: 2 }),
    JSON.stringify({
      ...feed,
      entries: [{ ...feed.entries[0], releasedOn: undefined }],
    }),
    ' '.repeat(1_048_577),
  ]) {
    expect(
      await createReleaseNotesReader({
        fetchImpl: () => Promise.resolve(new Response(body)),
      })(url),
    ).toBeNull();
  }
});
test('aborts a stalled response and permits only HTTPS or loopback HTTP', async () => {
  const fetchImpl: typeof fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(new Error('aborted')),
      );
    });
  expect(
    await createReleaseNotesReader({ fetchImpl, timeoutMs: 5 })(url),
  ).toBeNull();
  const healthy = jest.fn(() => Promise.resolve(Response.json(feed)));
  const read = createReleaseNotesReader({ fetchImpl: healthy });
  for (const value of [
    'file:///tmp/notes',
    'http://example.test/notes',
    'https://user:pass@example.test/notes',
  ])
    expect(await read(value)).toBeNull();
  expect(healthy).not.toHaveBeenCalled();
  expect(await read('http://127.0.0.1:1234/notes')).toEqual(feed);
});

test('bounds a real response that sends headers then stalls its body', async () => {
  // A real socket server is the point of this test; app-core itself stays browser-safe.
  // oxlint-disable-next-line no-restricted-imports
  const { createServer } = await import('node:http');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"schemaVersion":1,"entries":[');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No fixture port');
    const result = await createReleaseNotesReader({ timeoutMs: 50 })(
      `http://127.0.0.1:${address.port}/notes`,
    );
    expect(result).toBeNull();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
