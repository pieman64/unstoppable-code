import readline from 'node:readline';

const profile = process.argv[2] ?? 'normal';
const requests = readline.createInterface({ input: process.stdin });
const turns = new Map();
const permissions = new Map();
const pendingRequests = new Set();
let sessionCounter = 0;
let permissionCounter = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function update(sessionId, value) {
  send({ method: 'session/update', params: { sessionId, update: value } });
}

function text(sessionId, value) {
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: value },
  });
}

function complete(sessionId, result = { stopReason: 'end_turn' }) {
  const turn = turns.get(sessionId);
  if (!turn) return;
  turns.delete(sessionId);
  respond(turn.id, result);
}

function permission(sessionId, permanentOnly = false) {
  const id = `permission-${++permissionCounter}`;
  permissions.set(id, sessionId);
  send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { toolCallId: id, title: 'Run test command', kind: 'execute' },
      options: [
        {
          optionId: `${id}-always`,
          name: 'Always allow',
          kind: 'allow_always',
        },
        ...(permanentOnly
          ? []
          : [
              { optionId: `${id}-yes`, name: 'Allow once', kind: 'allow_once' },
              {
                optionId: `${id}-no`,
                name: 'Reject once',
                kind: 'reject_once',
              },
            ]),
      ],
    },
  });
}

function handlePermissionResponse(message) {
  const sessionId = permissions.get(message.id);
  if (sessionId) {
    permissions.delete(message.id);
    const turn = turns.get(sessionId);
    if (turn) {
      turn.responses.push({ id: message.id, ...message.result });
      text(sessionId, `permission-replied:${message.id}`);
      if (turn.responses.length === turn.expected) {
        complete(sessionId, {
          stopReason: 'end_turn',
          _meta: { permissions: turn.responses },
        });
      }
    }
  }
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (message.method === 'initialize') {
    if (profile === 'no-initialize') return;
    send({
      id: message.id,
      result: {
        protocolVersion: profile === 'wrong-version' ? 2 : 1,
        agentInfo: { name: 'fake-acp', version: '1.0.0' },
        agentCapabilities:
          profile === 'normal' || profile === 'wrong-version'
            ? {}
            : {
                loadSession: true,
                promptCapabilities: {
                  image: true,
                  audio: true,
                  embeddedContext: true,
                },
                mcpCapabilities: { http: true, sse: true },
                sessionCapabilities: {
                  list: {},
                  fork: {},
                  resume: {},
                  close: {},
                  delete: {},
                  additionalDirectories: {},
                },
              },
        authMethods: [{ id: 'test', name: 'Test authentication' }],
        _meta: { futureExtension: { enabled: true }, client: message.params },
      },
    });
  } else if (method === 'authenticate') {
    respond(id, {});
  } else if (method === 'session/new') {
    const sessionId =
      profile === 'duplicate-session' ? 'same' : `session-${++sessionCounter}`;
    if (
      profile === 'early-update' ||
      profile === 'flood-updates' ||
      profile === 'large-early-updates'
    ) {
      text('unrelated-session', 'ignore');
      const count = profile === 'early-update' ? 1 : 70;
      for (let i = 0; i < count; i++) {
        text(
          sessionId,
          profile === 'large-early-updates'
            ? `early-${i}:${'x'.repeat(2048)}`
            : 'early',
        );
      }
    }
    respond(id, { sessionId, _meta: { received: params } });
  } else if (method === 'session/fork') {
    const sessionId =
      profile === 'fork-duplicate'
        ? params.sessionId
        : `session-${++sessionCounter}`;
    text('unrelated-fork', 'ignore');
    for (let i = 0; i < (profile === 'fork-flood' ? 70 : 1); i++)
      text(sessionId, 'fork replay');
    const result = { sessionId, _meta: { received: params } };
    if (profile === 'fork-slow') setTimeout(() => respond(id, result), 75);
    else respond(id, result);
  } else if (method === 'session/load' || method === 'session/resume') {
    text(params.sessionId, 'replay');
    if (profile === 'slow-attach') setTimeout(() => respond(id, {}), 75);
    else respond(id, { _meta: { received: params } });
  } else if (method === 'session/set_config_option') {
    respond(id, {
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: params.value,
          options: [{ value: params.value, name: params.value }],
        },
      ],
    });
  } else if (method === 'session/close' || method === 'session/delete') {
    if (profile === 'slow-close') setTimeout(() => respond(id, {}), 75);
    else respond(id, {});
  } else if (method === 'session/list') {
    if (profile === 'slow-list' || profile === 'ignore-rpc-cancel') {
      pendingRequests.add(id);
      for (const sessionId of turns.keys()) text(sessionId, 'list-pending');
    } else respond(id, { sessions: [], nextCursor: 'page-2' });
  } else if (method === '$/cancel_request') {
    if (
      pendingRequests.delete(params.requestId) &&
      profile !== 'ignore-rpc-cancel'
    ) {
      send({
        id: params.requestId,
        error: { code: -32800, message: 'Cancelled' },
      });
    }
  } else if (method === 'session/cancel') {
    if (profile !== 'ignore-turn-cancel')
      complete(params.sessionId, { stopReason: 'cancelled' });
  } else if (method === 'session/prompt') {
    handlePrompt(id, params);
  } else if (method === 'vendor/echo') {
    respond(id, { echoed: params });
  } else if (method === 'vendor/missing') {
    send({ id, error: { code: -32601, message: 'Method not found' } });
  } else if (method === 'vendor/hang') {
    pendingRequests.add(id);
  } else if (method === 'fake/echo') {
    respond(id, { echoed: params });
  }
}

function handlePrompt(id, params) {
  const instruction = params.prompt.find(
    (content) => content.type === 'text',
  )?.text;
  turns.set(params.sessionId, {
    id,
    responses: [],
    expected: instruction === 'two-permissions' ? 2 : 1,
  });
  if (instruction === 'wait') text(params.sessionId, 'waiting');
  else if (instruction === 'slow')
    setTimeout(() => complete(params.sessionId), 1000);
  else if (instruction === 'permission' || instruction === 'permanent-only')
    permission(params.sessionId, instruction === 'permanent-only');
  else if (instruction === 'two-permissions') {
    permission(params.sessionId);
    permission(params.sessionId);
  } else if (instruction === 'disconnect') process.exit(0);
  else if (instruction === 'provider-error') {
    turns.delete(params.sessionId);
    send({
      id,
      error: {
        code: -32000,
        message: 'SECRET provider auth token',
        data: { token: 'SECRET' },
      },
    });
  } else if (instruction === 'malformed')
    process.stdout.write('SECRET invalid JSON\n');
  else if (instruction === 'unknown-update') {
    for (let i = 0; i < 80; i++)
      update(params.sessionId, {
        sessionUpdate: 'SECRET-vendor-update',
        payload: 'SECRET-private-payload'.repeat(200),
      });
    complete(params.sessionId);
  } else if (instruction === 'bad-envelope')
    process.stdout.write('["SECRET"]\n');
  else if (instruction === 'oversized') process.stdout.write('x'.repeat(8192));
  else if (instruction === 'oversized-line')
    process.stdout.write(`${'x'.repeat(3000)}\n`);
  else if (instruction === 'truncated') process.stdout.end('{"jsonrpc":"2.0"');
  else if (instruction === 'fragmented') {
    const frame = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '🌳' } } } })}\n`,
    );
    let offset = 0;
    function writeByte() {
      if (offset < frame.length) {
        process.stdout.write(frame.subarray(offset, ++offset));
        setImmediate(writeByte);
      } else complete(params.sessionId);
    }
    writeByte();
  } else if (instruction === 'pressure') {
    let sequence = 0;
    const pump = () => {
      while (sequence < 128) {
        const accepted = process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `${sequence}:${'x'.repeat(2048)}`,
                },
              },
            },
          })}\n`,
        );
        sequence += 1;
        if (!accepted) {
          process.stdout.once('drain', pump);
          return;
        }
      }
      complete(params.sessionId);
    };
    pump();
  } else if (instruction === 'single-held-update') {
    text(params.sessionId, 'held-before-terminal');
    complete(params.sessionId);
  } else {
    text('unrelated-session', 'ignore');
    text(params.sessionId, 'hello');
    update(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read file',
      status: 'in_progress',
      _meta: { future: 1 },
    });
    update(params.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed',
    });
    text(params.sessionId, ' world');
    complete(params.sessionId);
  }
}

requests.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method) handleRequest(message);
  else handlePermissionResponse(message);
});
requests.on('close', () => process.exit(0));
