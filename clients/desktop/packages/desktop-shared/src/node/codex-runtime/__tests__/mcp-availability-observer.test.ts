import { McpAvailabilityObserver } from '../mcp-availability-observer';

function setup(): { observer: McpAvailabilityObserver; publish: jest.Mock } {
  const publish = jest.fn();
  return { observer: new McpAvailabilityObserver(publish), publish };
}
const request = (id: number, method: string, cursor?: string): unknown => ({
  jsonrpc: '2.0',
  id,
  method,
  params: cursor ? { cursor } : {},
});
const response = (id: number, result: unknown): unknown => ({
  jsonrpc: '2.0',
  id,
  result,
});
const tool = { name: 'read', inputSchema: { type: 'object' } };

test('requires a correlated initialization and every tool page on the same connection', () => {
  const { observer, publish } = setup();
  observer.response(response(99, { tools: [tool] }));
  expect(publish).not.toHaveBeenCalled();
  observer.request(request(1, 'initialize'));
  observer.response(
    response(1, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    }),
  );
  observer.request(request(2, 'tools/list'));
  observer.response(response(2, { tools: [tool], nextCursor: 'next' }));
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
  observer.request(request(3, 'tools/list', 'next'));
  observer.response(response(3, { tools: [{ ...tool, name: 'write' }] }));
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'tools',
    initialized: true,
    complete: true,
    toolCount: 2,
  });
  observer.response({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  });
  expect(publish).toHaveBeenLastCalledWith({ kind: 'connecting' });
});

test.each([
  { tools: [tool, tool] },
  { tools: [{ name: 'bad' }] },
  { tools: [tool], nextCursor: '' },
])('does not attest invalid or ambiguous catalogs: %j', (result) => {
  const { observer, publish } = setup();
  observer.request(request(1, 'initialize'));
  observer.response(
    response(1, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture', version: '1' },
    }),
  );
  observer.request(request(2, 'tools/list'));
  observer.response(response(2, result));
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
});

test('never uses a discovery response from another connection or a closed owner', () => {
  const { observer, publish } = setup();
  observer.request(request(1, 'tools/list'));
  observer.response(response(1, { tools: [tool] }));
  observer.close();
  observer.request(request(2, 'initialize'));
  observer.response(
    response(2, {
      protocolVersion: '2025-03-26',
      capabilities: {},
      serverInfo: { name: 'fixture', version: '1' },
    }),
  );
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
});
