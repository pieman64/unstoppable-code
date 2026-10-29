import { PassThrough } from 'node:stream';
import { McpAvailabilityObserver } from '../mcp-availability-observer';
import { observeMcpStdio } from '../mcp-stdio-observer';

it('observes fragmented UTF-8 metadata and releases listeners on abort', () => {
  const input = new PassThrough();
  const upstreamOutput = new PassThrough();
  const controller = new AbortController();
  const publish = jest.fn();
  observeMcpStdio({
    input,
    upstreamOutput,
    observer: new McpAvailabilityObserver(publish),
    signal: controller.signal,
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  const initialized = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: '🦊', version: '1' },
      },
    }) + '\n',
  );
  const split = initialized.indexOf(Buffer.from('🦊')) + 1;
  upstreamOutput.write(initialized.subarray(0, split));
  upstreamOutput.write(initialized.subarray(split));
  input.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  upstreamOutput.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'read', inputSchema: { type: 'object' } }] },
    }) + '\n',
  );
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'tools',
    initialized: true,
    complete: true,
    toolCount: 1,
  });
  controller.abort();
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'unavailable',
    reasonCode: 'disconnected',
  });
  expect(input.listenerCount('data')).toBe(0);
  expect(upstreamOutput.listenerCount('data')).toBe(0);
  input.destroy();
  upstreamOutput.destroy();
});

it.each(['request', 'response'])(
  'bounds observation of an oversized %s without destroying either transport',
  (direction) => {
    const input = new PassThrough();
    const upstreamOutput = new PassThrough();
    const publish = jest.fn();
    observeMcpStdio({
      input,
      upstreamOutput,
      observer: new McpAvailabilityObserver(publish),
      signal: new AbortController().signal,
    });
    const stream = direction === 'request' ? input : upstreamOutput;
    for (let i = 0; i < 34; i++) stream.write(Buffer.alloc(64 * 1024, 120));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      kind: 'unavailable',
      reasonCode: 'disconnected',
    });
    expect(input.destroyed).toBe(false);
    expect(upstreamOutput.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
    expect(upstreamOutput.listenerCount('data')).toBe(0);
    input.destroy();
    upstreamOutput.destroy();
  },
);
