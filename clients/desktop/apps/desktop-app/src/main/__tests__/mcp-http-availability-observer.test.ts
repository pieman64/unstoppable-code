import { McpAvailabilityObserver } from '@canopy/desktop-shared/node/codex-runtime/mcp-availability-observer';
import { McpHttpAvailabilityObserver } from '../mcp/http-availability-observer';

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
});
const initialized = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {} },
    serverInfo: { name: 'fixture', version: '1' },
  },
};
const tools = (
  id: number,
  names: string[],
  nextCursor?: string,
): {
  jsonrpc: string;
  id: number;
  result: {
    tools: { name: string; inputSchema: { type: string } }[];
    nextCursor?: string;
  };
} => ({
  jsonrpc: '2.0',
  id,
  result: {
    tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })),
    ...(nextCursor ? { nextCursor } : {}),
  },
});
function setup(): {
  observer: McpHttpAvailabilityObserver;
  publish: jest.Mock;
  connection: McpAvailabilityObserver;
} {
  const publish = jest.fn();
  const observer = new McpHttpAvailabilityObserver(
    () => new McpAvailabilityObserver(publish),
  );
  const connection = required(observer.request(initialize, ''));
  const init = observer.response(connection, 'session', 'application/json');
  init.data(Buffer.from(JSON.stringify(initialized)));
  init.end();
  return { observer, publish, connection };
}
function list(
  observer: McpHttpAvailabilityObserver,
  id: number,
  cursor?: string,
): McpAvailabilityObserver {
  return required(
    observer.request(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
        params: cursor ? { cursor } : {},
      }),
      'session',
    ),
  );
}

test('correlates assigned HTTP sessions and fragmented SSE pages before readiness', () => {
  const { observer, publish, connection } = setup();
  expect(list(observer, 2)).toBe(connection);
  const first = observer.response(
    connection,
    'session',
    'text/event-stream; charset=utf-8',
  );
  const wire = Buffer.from(
    `event: message\r\ndata: ${JSON.stringify(tools(2, ['café'], 'page2'))}\r\n\r\n`,
  );
  for (const byte of wire) first.data(Buffer.from([byte]));
  first.end();
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
  const second = observer.response(
    list(observer, 3, 'page2'),
    'session',
    'application/json',
  );
  second.data(Buffer.from(JSON.stringify(tools(3, ['write']))));
  second.end();
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'tools',
    initialized: true,
    complete: true,
    toolCount: 2,
  });
});

test('OAuth failure invalidates in-flight responses and requires a new initialize', () => {
  const { observer, publish, connection } = setup();
  list(observer, 2);
  const response = observer.response(connection, 'session', 'application/json');
  observer.authenticationRequired();
  response.data(Buffer.from(JSON.stringify(tools(2, ['read']))));
  response.end();
  expect(publish).toHaveBeenLastCalledWith({ kind: 'auth_required' });
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
});

test('does not accept responses from a replaced connection', () => {
  const { observer, publish, connection } = setup();
  list(observer, 2);
  observer.request(initialize, 'session');
  const stale = observer.response(connection, undefined, 'application/json');
  stale.data(Buffer.from(JSON.stringify(tools(2, ['old']))));
  stale.end();
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
});

test('bounds an oversized event and ignores incomplete SSE frames', () => {
  const { observer, publish, connection } = setup();
  list(observer, 2);
  const incomplete = observer.response(
    connection,
    undefined,
    'text/event-stream',
  );
  incomplete.data(Buffer.from(`data: ${JSON.stringify(tools(2, ['read']))}\n`));
  incomplete.end();
  expect(publish).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'tools' }),
  );
  const oversized = observer.response(
    connection,
    undefined,
    'text/event-stream',
  );
  oversized.data(Buffer.alloc(2 * 1024 * 1024 + 1));
  oversized.end();
  expect(publish).toHaveBeenLastCalledWith({
    kind: 'unavailable',
    reasonCode: 'disconnected',
  });
});

test('a late response cannot replace the new connection session mapping', () => {
  const { observer, connection } = setup();
  const current = required(observer.request(initialize, 'session'));
  const stale = observer.response(connection, 'session', 'application/json');
  stale.data(Buffer.from(JSON.stringify(initialized)));
  stale.end();
  expect(list(observer, 2)).toBe(current);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected fixture value');
  return value;
}
