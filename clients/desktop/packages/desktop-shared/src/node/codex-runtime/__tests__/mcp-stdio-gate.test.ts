import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { McpAvailabilityObserver } from '../mcp-availability-observer';
import { relayGovernedMcpStdio } from '../mcp-stdio-gate';

const nextTurn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function setup(): {
  input: PassThrough;
  upstreamOutput: PassThrough;
  controller: AbortController;
  publish: jest.Mock;
  initialize: () => Promise<void>;
  list: () => Promise<void>;
  cleanup: () => Promise<void>;
} {
  const input = new PassThrough();
  const upstreamInput = new PassThrough();
  const upstreamOutput = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const publish = jest.fn();
  const done = relayGovernedMcpStdio({
    input,
    upstreamInput,
    upstreamOutput,
    output,
    gate: () => Promise.resolve(true),
    observer: new McpAvailabilityObserver(publish),
    signal: controller.signal,
  }).then(
    () => undefined,
    () => undefined,
  );
  const request = async (value: unknown): Promise<void> => {
    const forwarded = once(upstreamInput, 'data');
    input.write(JSON.stringify(value) + '\n');
    await forwarded;
  };
  const response = async (value: unknown): Promise<void> => {
    const forwarded = once(output, 'data');
    upstreamOutput.write(JSON.stringify(value) + '\n');
    await forwarded;
    await nextTurn();
  };
  const initialize = async (): Promise<void> => {
    await request({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    await response({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        serverInfo: { name: 'fixture', version: '1' },
      },
    });
    await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  };
  const list = async (): Promise<void> => {
    await response({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{ name: 'read', inputSchema: { type: 'object' } }],
      },
    });
    expect(publish).toHaveBeenLastCalledWith({
      kind: 'tools',
      initialized: true,
      complete: true,
      toolCount: 1,
    });
  };
  const cleanup = async (): Promise<void> => {
    controller.abort();
    input.end();
    upstreamOutput.end();
    await done;
    input.destroy();
    upstreamInput.destroy();
    upstreamOutput.destroy();
    output.destroy();
  };
  return {
    input,
    upstreamOutput,
    controller,
    publish,
    initialize,
    list,
    cleanup,
  };
}

it.each(['end', 'close', 'abort'])(
  'revokes ready evidence on upstream %s while requests stay open',
  async (event) => {
    const relay = setup();
    try {
      await relay.initialize();
      await relay.list();
      if (event === 'end') relay.upstreamOutput.end();
      else if (event === 'close') relay.upstreamOutput.destroy();
      else relay.controller.abort();
      await nextTurn();
      expect(relay.input.writableEnded).toBe(false);
      expect(relay.publish).toHaveBeenLastCalledWith({
        kind: 'unavailable',
        reasonCode: 'disconnected',
      });
    } finally {
      await relay.cleanup();
    }
  },
);

it('allows the final server response after request input is half-closed', async () => {
  const relay = setup();
  try {
    await relay.initialize();
    relay.input.end();
    await nextTurn();
    await relay.list();
  } finally {
    await relay.cleanup();
  }
});

it('rejects a tool call when no approval gate was supplied', async () => {
  const input = new PassThrough();
  const upstreamInput = new PassThrough();
  const upstreamOutput = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const forwarded = jest.fn();
  const returned = jest.fn();
  upstreamInput.on('data', forwarded);
  output.on('data', returned);
  const done = relayGovernedMcpStdio({
    input,
    upstreamInput,
    upstreamOutput,
    output,
    signal: controller.signal,
  }).then(
    () => undefined,
    () => undefined,
  );
  try {
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mutate', arguments: {} },
      }) + '\n',
    );
    await nextTurn();
    expect(forwarded).not.toHaveBeenCalled();
    expect(returned).toHaveBeenCalledWith(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          error: {
            code: -32000,
            message: 'The MCP tool call was not approved.',
          },
        }) + '\n',
      ),
    );
  } finally {
    controller.abort();
    input.end();
    upstreamOutput.end();
    await done;
    input.destroy();
    upstreamInput.destroy();
    upstreamOutput.destroy();
    output.destroy();
  }
});
