import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  readOpenCodeRuntimeJson,
  readOpenCodeToolCatalog,
} from '../runtime-api';

it('metadata requests use only authenticated owned loopback endpoints and reject redirects', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers.authorization ?? '');
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://example.test' });
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end('{"all":[]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const signal = AbortSignal.timeout(5_000);
    await expect(
      readOpenCodeRuntimeJson(base, '/models', 'fixture-secret', signal),
    ).resolves.toEqual({ all: [] });
    expect(requests).toEqual(['Bearer fixture-secret']);
    await expect(
      readOpenCodeRuntimeJson(base, '/redirect', 'secret', signal),
    ).rejects.toThrow();
    for (const invalid of [
      'https://example.test',
      'http://user:secret@127.0.0.1:1234',
      'http://127.0.0.1:1234/other',
    ])
      await expect(
        readOpenCodeRuntimeJson(invalid, '/models', 'secret', signal),
      ).rejects.toThrow('invalid local endpoint');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('waits for v2 late MCP registration before capturing the tool catalog', async () => {
  const read = jest
    .fn<Promise<unknown>, []>()
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ id: 'selected_tool' }]);
  await expect(
    readOpenCodeToolCatalog(read, ['selected_tool'], AbortSignal.timeout(5000)),
  ).resolves.toEqual([{ id: 'selected_tool' }]);
  expect(read).toHaveBeenCalledTimes(2);
});

it('fails when selected v2 MCP tools never register', async () => {
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValueOnce(0)
    .mockReturnValue(15_000);
  const read = jest
    .fn<Promise<unknown>, []>()
    .mockResolvedValue([{ id: 'other_tool' }]);
  try {
    await expect(
      readOpenCodeToolCatalog(
        read,
        ['selected_tool'],
        AbortSignal.timeout(5000),
      ),
    ).rejects.toThrow('OpenCode did not load the selected MCP tools.');
  } finally {
    now.mockRestore();
  }
  expect(read).toHaveBeenCalledTimes(1);
});

it('cancels while selected v2 MCP tools remain unavailable', async () => {
  const controller = new AbortController();
  const read = (): Promise<unknown> => {
    controller.abort();
    return Promise.resolve([]);
  };
  await expect(
    readOpenCodeToolCatalog(read, ['selected_tool'], controller.signal),
  ).rejects.toThrow();
});
