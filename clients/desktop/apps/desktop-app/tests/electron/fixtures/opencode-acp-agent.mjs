import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadOpenCodeV2FixturePlugin } from '../../../../../scripts/test-support/opencode-v2-plugin.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const lifecycle = (stage, details = {}) => {
  if (!process.env.OPENCODE_FIXTURE_LIFECYCLE_LOG) return;
  appendFileSync(
    process.env.OPENCODE_FIXTURE_LIFECYCLE_LOG,
    JSON.stringify({ at: Date.now(), stage, ...details }) + '\n',
  );
};

if (process.argv.includes('auth')) {
  process.stdout.write(
    'OpenCode provider sign-in fixture. Press Enter to finish.\n',
  );
  process.stdin.once('data', () => {
    process.exit(0);
  });
  await new Promise(() => {});
}
const nativeForks = process.env.OPENCODE_FIXTURE_NATIVE_FORK === '1';
const nativeUsage = process.env.OPENCODE_FIXTURE_USAGE === '1';
const noEffort = process.env.OPENCODE_FIXTURE_EFFORT === 'absent';
const database = process.env.OPENCODE_DB;
if (nativeForks)
  process.on('uncaughtException', (error) => {
    writeFileSync(
      path.join(process.cwd(), '.opencode-native-fixture-error'),
      String(error),
    );
    process.exit(1);
  });
// The fixture stores its state in SQLite at the native location, outside the
// host profile. Its table is test-only; it does not emulate OpenCode's schema.
const fixtureDatabase = () => {
  mkdirSync(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(
    'CREATE TABLE IF NOT EXISTS fixture_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
  );
  return db;
};
const readDatabase = () => {
  const db = fixtureDatabase();
  try {
    const row = db
      .prepare('SELECT value FROM fixture_state WHERE id = 1')
      .get();
    return row ? JSON.parse(row.value) : { sessions: {} };
  } finally {
    db.close();
  }
};
const saveDatabase = (value) => {
  const db = fixtureDatabase();
  try {
    db.prepare(
      'INSERT OR REPLACE INTO fixture_state (id, value) VALUES (1, ?)',
    ).run(JSON.stringify(value));
  } finally {
    db.close();
  }
};
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const scopedProvider = config.provider?.pipeline?.models?.only;
const presentationModels = [];
const availableModels = [
  ...presentationModels,
  { value: 'fixture/model', name: 'Fixture model' },
  ...(scopedProvider
    ? [{ value: 'pipeline/only', name: 'Pipeline-only model' }]
    : []),
];
let plugin;
async function loadPlugin() {
  plugin ??= await loadOpenCodeV2FixturePlugin(config, {
    /* account-metadata-fixture */
    ...(nativeForks
      ? {
          session: {
            get: ({ sessionID }) => readDatabase().sessions[sessionID]?.info,
            context: ({ sessionID }) =>
              readDatabase().sessions[sessionID]?.messages ?? [],
            move: ({ sessionID, directory }) => {
              const db = readDatabase();
              db.sessions[sessionID].info.location.directory = directory;
              saveDatabase(db);
            },
            remove: ({ sessionID }) => {
              const db = readDatabase();
              delete db.sessions[sessionID];
              saveDatabase(db);
            },
          },
        }
      : {}),
    models: [
      {
        providerID: 'fixture',
        id: 'model',
        variants: noEffort ? [] : [{ id: 'medium' }, { id: 'high' }],
      },
      ...(scopedProvider
        ? [{ providerID: 'pipeline', id: 'only', variants: [{ id: 'high' }] }]
        : []),
    ],
    missingSession: () =>
      existsSync(path.join(process.cwd(), '.fixture-session-missing')),
  });
}
if (!nativeForks) await loadPlugin();
const beforeTool = (...args) => plugin.beforeTool(...args);
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const error = (id, code = -32602) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message: 'fixture error' },
    }) + '\n',
  );
let selected = 'fixture/model';
let effort = 'medium';
let sessionId = 'opencode-fixture';
let held;
let servers = [];
const counterFile = path.join(process.env.XDG_STATE_HOME, 'fixture-turns.json');
await mkdir(process.env.XDG_STATE_HOME, { recursive: true });
let turns = await readFile(counterFile, 'utf8').then(Number, () => 0);
const savedFile = path.join(
  process.env.XDG_STATE_HOME,
  'fixture-delegation.json',
);
let saved = await readFile(savedFile, 'utf8').then(JSON.parse, () => ({}));
const options = () => [
  ...(noEffort
    ? []
    : [
        {
          id: 'effort',
          name: 'Effort',
          type: 'select',
          currentValue: effort,
          options: ['medium', 'high'].map((value) => ({ name: value, value })),
        },
      ]),
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: selected,
    options: availableModels,
  },
];
const update = (update) =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    }) + '\n',
  );
const appTool = async (name, args, serverName) => {
  lifecycle('app-tool', { name, serverName });
  const server = servers.find((server) =>
    serverName
      ? server.name.toLowerCase().includes(serverName)
      : name === 'AskUserQuestion'
        ? server.name.endsWith('_ui')
        : !server.name.endsWith('_ui') && 'url' in server,
  );
  if (!server) throw new Error('App server unavailable');
  const client =
    'url' in server
      ? undefined
      : new Client({ name: 'opencode-fixture', version: '1' });
  if (client)
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: Object.fromEntries(
          server.env.map((entry) => [entry.name, entry.value]),
        ),
        stderr: 'pipe',
      }),
    );
  try {
    const headers = {
      ...Object.fromEntries(
        (server.headers ?? []).map((entry) => [entry.name, entry.value]),
      ),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const rpc = async (method, params) => {
      lifecycle('http-request', { method, serverName: server.name });
      const response = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method,
          params,
        }),
      });
      lifecycle('http-headers', {
        method,
        serverName: server.name,
        status: response.status,
        contentType: response.headers.get('content-type'),
      });
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
      const session = response.headers.get('mcp-session-id');
      if (session) headers['Mcp-Session-Id'] = session;
      const text = await response.text();
      lifecycle('http-body', { method, bytes: text.length });
      const message = JSON.parse(
        text.startsWith('event:') || text.startsWith('data:')
          ? text
              .split('\n')
              .find((line) => line.startsWith('data:'))
              .slice(5)
              .trim()
          : text,
      );
      if (message.error) throw new Error(message.error.message);
      return message.result;
    };
    if (!client)
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'opencode-fixture', version: '1' },
      });
    const listed = client
      ? await client.listTools()
      : await rpc('tools/list', {});
    if (name === 'VERIFY_COWORK_ACTION_CONTRACT') {
      const schema = listed.tools.find(
        (tool) => tool.name === 'DispatchAction',
      )?.inputSchema;
      return schema && !JSON.stringify(schema).includes('new_worktree')
        ? 'OpenCode Cowork offers only current chat placement.'
        : 'OpenCode Cowork advertises an unavailable worktree placement.';
    }
    if (name === 'VERIFY_DEFERRED_DISABLED') {
      if (
        listed.tools.some((tool) =>
          ['SearchDeferredTools', 'LoadDeferredTools'].includes(tool.name),
        )
      )
        throw new Error('Disabled discovery tools were advertised');
      return 'OpenCode discovery tools are disabled.';
    }
    if (name === 'SearchDeferredTools')
      await writeFile(
        path.join(process.cwd(), '.opencode-deferred-tools-listed'),
        JSON.stringify(listed.tools.map((tool) => tool.name)),
      );
    if (!listed.tools.some((tool) => tool.name === name))
      throw new Error(`App tool unavailable: ${name}`);
    const toolCallId = randomUUID();
    const toolName = `${server.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: toolName,
      kind: 'other',
      status: 'pending',
      rawInput: args,
    });
    await beforeTool(
      { sessionID: sessionId, callID: toolCallId, tool: toolName },
      { args },
    );
    const result = client
      ? await client.callTool({ name, arguments: args })
      : await rpc('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    if (
      name === 'LoadDeferredTools' &&
      process.env.OPENCODE_FIXTURE_DEFERRED_GATE === '1'
    ) {
      await writeFile(
        path.join(process.cwd(), '.opencode-deferred-http-result'),
        JSON.stringify(result),
      );
      const deadline = Date.now() + 30_000;
      while (
        !existsSync(
          path.join(process.cwd(), '.opencode-deferred-allow-completion'),
        )
      ) {
        if (Date.now() > deadline)
          throw new Error('Native completion gate timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      rawOutput:
        name === 'LoadDeferredTools'
          ? {
              output: result.content
                .filter((entry) => entry.type === 'text')
                .map((entry) => entry.text)
                .join('\n'),
              metadata: {},
            }
          : 'App tool completed.',
    });
    return result.content
      .filter((entry) => entry.type === 'text')
      .map((entry) => entry.text)
      .join('\n');
  } finally {
    await client?.close();
  }
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  lifecycle('acp-request', {
    method,
    ...(method === 'session/set_config_option'
      ? { configId: params.configId }
      : {}),
  });
  if (
    method === 'initialize' &&
    existsSync(path.join(process.cwd(), '.fixture-usage-init-failure'))
  )
    error(id, -32603);
  else if (method === 'initialize')
    reply(id, {
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.0.32' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          delete: {},
          ...(nativeForks ? { fork: {} } : {}),
        },
        mcpCapabilities: { http: true },
        promptCapabilities:
          process.env.OPENCODE_FIXTURE_PROMPT_CONTENT === 'disabled'
            ? {}
            : { image: true, embeddedContext: true },
      },
    });
  else if (method === 'session/delete') {
    if (nativeForks) {
      const db = readDatabase();
      delete db.sessions[params.sessionId];
      saveDatabase(db);
    }
    reply(id, {});
  } else if (method === 'session/new') {
    await loadPlugin();
    servers = params.mcpServers;
    await plugin.registerMcpServers(servers);
    sessionId = randomUUID();
    if (nativeForks) {
      const db = readDatabase();
      db.sessions[sessionId] = {
        info: {
          id: sessionId,
          location: { directory: process.cwd() },
          time: { created: Date.now() },
        },
        messages: [],
      };
      saveDatabase(db);
    }
    reply(id, { sessionId, configOptions: options() });
  } else if (method === 'session/fork' && nativeForks) {
    const db = readDatabase();
    const snapshot = structuredClone(db.sessions[params.sessionId]);
    const newId = randomUUID();
    snapshot.info.id = newId;
    snapshot.info.time = { created: Date.now() };
    snapshot.info.fork = {
      sessionID: params.sessionId,
      boundary: { type: 'through', messageID: snapshot.messages.at(-1)?.id },
    };
    snapshot.messages = snapshot.messages.map((message) => ({
      ...message,
      id: randomUUID(),
    }));
    db.sessions[newId] = snapshot;
    saveDatabase(db);
    sessionId = newId;
    reply(id, { sessionId, configOptions: options() });
  } else if (method === 'session/load') {
    await loadPlugin();
    servers = params.mcpServers;
    await plugin.registerMcpServers(servers);
    if (
      params.sessionId === 'missing' ||
      existsSync(path.join(process.cwd(), '.fixture-session-missing'))
    )
      error(id, -32603);
    else {
      sessionId = params.sessionId;
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Replayed history must not appear twice.',
        },
      });
      reply(id, { configOptions: options() });
    }
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'effort') {
      if (!existsSync(path.join(process.cwd(), '.fixture-effort-mismatch')))
        effort = params.value;
      reply(id, { configOptions: options() });
    } else if (!availableModels.some((model) => model.value === params.value))
      error(id);
    else {
      selected = params.value;
      reply(id, { configOptions: options() });
    }
  } else if (method === 'session/prompt') {
    turns++;
    await writeFile(counterFile, String(turns));
    const text = params.prompt.map((part) => part.text ?? '').join('\n');
    const reportsUsage =
      nativeUsage && text.includes('OPENCODE_USAGE_REPORTED');
    if (reportsUsage) {
      update({
        sessionUpdate: 'usage_update',
        used: 1234,
        size: 10000,
        cost: { amount: 100 + turns * 0.75, currency: 'USD' },
      });
    }
    if (text.includes('HOLD')) {
      held = id;
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting for Stop.' },
      });
      continue;
    }
    let result = `OpenCode fixture reply ${turns}.`;
    if (process.env.OPENCODE_FIXTURE_VISIBLE_FORK === '1') {
      if (text.includes('FORK_CONTEXT_CHECK')) {
        result =
          text.includes('FORK_KEEP_ALPHA') &&
          text.includes('FORK_KEEP_REPLY') &&
          !text.includes('FORK_OMIT_OMEGA')
            ? 'OpenCode received the selected visible text.'
            : 'OpenCode did not receive the selected visible text.';
      } else if (text.includes('FORK_KEEP_ALPHA')) result = 'FORK_KEEP_REPLY';
    }
    if (process.env.OPENCODE_FIXTURE_PLAN === '1') {
      if (
        text.includes('OPENCODE_PROPOSE_PLAN') ||
        text.includes('OPENCODE_REVISE_PLAN')
      ) {
        const version = text.includes('OPENCODE_REVISE_PLAN')
          ? 'revised'
          : 'initial';
        result = `<proposed_plan># Parser validation (${version})\n\n## Implementation\nAdd input validation and regression coverage.\n\n## Verifications\nRun the parser tests.</proposed_plan>`;
      } else if (text.includes('Approved')) {
        result = text.includes('Plan mode instructions are no longer active')
          ? 'OpenCode implementation started in default mode.'
          : 'OpenCode implementation still has stale plan instructions.';
      }
    }

    if (nativeForks) {
      const db = readDatabase();
      const snapshot = db.sessions[sessionId];
      const inherited = snapshot.messages.find(
        (message) =>
          message.type === 'system' &&
          message.text === 'NATIVE_FORK_ONLY_CONTEXT',
      );
      const visibleSource =
        text.includes('OPENCODE_NATIVE_FORK') ||
        text.includes('OPENCODE_NATIVE_BRANCH');
      if (visibleSource) {
        const messageId = randomUUID();
        snapshot.messages.push({
          id: messageId,
          type: 'system',
          text: 'NATIVE_FORK_ONLY_CONTEXT',
          time: { created: Date.now() },
        });
        saveDatabase(db);
        const branched = text.includes('OPENCODE_NATIVE_BRANCH');
        const started = JSON.parse(
          await appTool(branched ? 'StartBranchedAgent' : 'StartForkedAgent', {
            followUpInstruction:
              'CHILD_NATIVE_CONTEXT_CHECK: continue with your retained native context.',
          }),
        );
        await writeFile(
          path.join(process.cwd(), '.opencode-native-fork-result'),
          JSON.stringify({ ...started, sourceSessionId: sessionId }),
        );
        result = 'OpenCode independent fork started.';
      } else if (text.includes('CHILD_NATIVE_CONTEXT_CHECK')) {
        if (!inherited)
          throw new Error(
            'Native-only context was lost before child continuation',
          );
        result = 'OpenCode child retained native-only context.';
        if (process.env.OPENCODE_FIXTURE_NATIVE_FORK_REPORT)
          await writeFile(
            process.env.OPENCODE_FIXTURE_NATIVE_FORK_REPORT,
            JSON.stringify({
              sessionId,
              inheritedSessionId: sessionId,
              hiddenContextPreserved: true,
            }),
          );
      }
    }
    if (text.includes('OPENCODE_DEFERRED_DISABLED')) {
      result = await appTool('VERIFY_DEFERRED_DISABLED', {});
    } else if (text.includes('OPENCODE_DEFERRED_LOAD')) {
      const found = JSON.parse(
        await appTool('SearchDeferredTools', {
          queries: [{ text: 'Deferred Reload Fixture', kinds: ['mcp'] }],
        }),
      );
      if (found.provider !== 'opencode')
        throw new Error('Wrong deferred catalog provider');
      const ref = found.results[0]?.matches[0]?.ref;
      if (!ref) throw new Error('Deferred fixture unavailable');
      saved.deferred = { pid: process.pid, sessionId, turns };
      await writeFile(savedFile, JSON.stringify(saved));
      await appTool('LoadDeferredTools', { items: [{ ref }] });
      held = id;
      continue;
    } else if (
      saved.deferred &&
      !saved.deferred.completed &&
      text.includes('Requested items now enabled')
    ) {
      const echoed = await appTool(
        'deferred_echo',
        { message: 'OpenCode after reload' },
        'deferred-reload',
      );
      if (!echoed.includes('OpenCode after reload'))
        throw new Error('New MCP tool was not callable');
      await writeFile(
        path.join(process.cwd(), '.opencode-deferred-resumed'),
        JSON.stringify({
          before: saved.deferred,
          after: { pid: process.pid, sessionId, turns },
        }),
      );
      saved.deferred.completed = true;
      await writeFile(savedFile, JSON.stringify(saved));
      result = 'OpenCode resumed once with its requested MCP tool.';
    }

    if (text.includes('OPENCODE_SELECTED_SKILL')) {
      const selected = text.match(/Read ("[^\n]+") for its instructions\./);
      if (!selected)
        throw new Error('Selected pipeline skill was not delivered.');
      const args = { path: JSON.parse(selected[1]) };
      const toolCallId = randomUUID();
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'read',
        kind: 'read',
        status: 'pending',
        rawInput: args,
      });
      await beforeTool(
        { sessionID: sessionId, callID: toolCallId, tool: 'read' },
        { args },
      );
      const skill = await readFile(args.path, 'utf8');
      if (!skill.includes('OPENCODE_PIPELINE_SKILL_SENTINEL'))
        throw new Error('Selected pipeline skill contents were not delivered.');
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput: 'Selected pipeline skill loaded.',
      });
      result = 'OpenCode loaded its selected pipeline skill.';
    }
    if (text.includes('WRITE')) {
      const filePath = path.join(process.cwd(), 'opencode-sentinel.txt');
      const args = { path: filePath, content: 'approved' };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'write-1',
        title: 'write',
        kind: 'edit',
        status: 'pending',
        rawInput: args,
      });
      try {
        await beforeTool(
          { sessionID: sessionId, callID: 'write-1', tool: 'write' },
          { args },
        );
        await writeFile(args.path, args.content);
        result = 'OpenCode write allowed.';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'completed',
          rawOutput: 'written',
        });
      } catch {
        result = 'OpenCode write denied.';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'failed',
          rawOutput: 'denied',
        });
      }
    }
    if (text.includes('OPENCODE_DOTTED_TOOL')) {
      try {
        await appTool('files.read', { value: 'valid' }, 'discovery');
        result = 'Dotted tool allowed.';
      } catch {
        result = 'Dotted tool denied.';
      }
    }
    if (text.includes('OPENCODE_ANNOTATED_TOOL')) {
      try {
        await appTool('echo', { value: 'valid' }, 'discovery');
        result = 'Annotated tool allowed.';
      } catch {
        result = 'Annotated tool denied.';
      }
    }
    if (text.includes('OPENCODE_UNKNOWN_UPDATE')) {
      for (let i = 0; i < 80; i++)
        update({
          sessionUpdate: 'PRIVATE_VENDOR_KIND',
          payload: 'PRIVATE_VENDOR_PAYLOAD'.repeat(200),
        });
    }
    if (text.includes('OPENCODE_IGNORED_UPDATES')) {
      for (let i = 0; i < 80; i++)
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'PRIVATE_COMMAND', description: 'PRIVATE_DESCRIPTION' },
          ],
        });
    }
    if (text.includes('OPENCODE_COWORK_ACTION_CONTRACT')) {
      result = await appTool('VERIFY_COWORK_ACTION_CONTRACT', {});
    }
    if (text.includes('OPENCODE_COWORK_IMAGE')) {
      const image = params.prompt.find((block) => block.type === 'image');
      result =
        image?.data ===
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII='
          ? 'OpenCode received the Cowork image.'
          : 'Cowork image delivery missing.';
    }
    if (text.includes('OPENCODE_ATTACHMENTS')) {
      await writeFile(
        path.join(process.cwd(), '.opencode-content-prompted'),
        'yes',
      );
      const image = params.prompt.find((block) => block.type === 'image');
      const resource = params.prompt.find((block) => block.type === 'resource');
      result =
        image?.data ===
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jk1sAAAAASUVORK5CYII=' &&
        resource?.resource?.text === 'Attachment content sentinel.'
          ? 'OpenCode received the image and document contents.'
          : 'Attachment delivery missing.';
    }
    if (text.includes('OPENCODE_CODE_GRAPH')) {
      await appTool('GetCodeGraphContext', {});
      result = 'OpenCode inspected the code graph.';
    }
    if (text.includes('OPENCODE_APP_TOOL')) {
      await appTool('GetGitPreferences', { type: 'branch-name' });
      result = 'OpenCode app tool completed.';
    }
    if (text.includes('OPENCODE_ADVISOR')) {
      await appTool('GetCurrentUiState', {});
      result = 'OpenCode Advisor inspected the app.';
    }
    if (text.includes('OPENCODE_MCP_ASK')) {
      const answer = await appTool('AskUserQuestion', {
        questions: [
          { question: 'Choose the fixture color', options: ['Blue', 'Green'] },
        ],
      });
      if (!answer.includes('Green'))
        throw new Error('Selected answer did not reach tool');
      result = 'Selected Green.';
    }
    if (text.includes('OPENCODE_DELEGATION_PARENT')) {
      const response = JSON.parse(
        await appTool('DelegateTask', {
          model: 'opencode:fixture%2Fmodel',
          description: 'Read delegated evidence',
          prompt: 'OPENCODE_CHILD_READ',
        }),
      );
      if (!response.ok) throw new Error(JSON.stringify(response));
      saved.delegationId = response.value.delegationId;
      await writeFile(savedFile, JSON.stringify(saved));
      await appTool('WatchDelegates', {
        delegationIds: [saved.delegationId],
        mode: 'all',
        timeoutMs: 60000,
      });
      result = 'Waiting for delegated evidence.';
    } else if (saved.delegationId) {
      result = `Integrated OpenCode child: ${await appTool('GetDelegateOutput', { delegationId: saved.delegationId })}`;
    }
    if (text.includes('OPENCODE_CHILD_READ')) {
      const args = {
        path: path.join(process.cwd(), 'delegation-evidence.txt'),
      };
      const toolCallId = randomUUID();
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'read',
        kind: 'read',
        status: 'pending',
        rawInput: args,
      });
      await beforeTool(
        { sessionID: sessionId, callID: toolCallId, tool: 'read' },
        { args },
      );
      result = await readFile(args.path, 'utf8');
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput: result,
      });
    }
    update({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking.' },
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: result },
    });
    reply(id, {
      stopReason: 'end_turn',
      ...(reportsUsage
        ? {
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              thoughtTokens: 10,
              cachedReadTokens: 30,
              cachedWriteTokens: 20,
              totalTokens: 210,
            },
          }
        : {}),
    });
  } else if (method === 'session/cancel' && held !== undefined) {
    reply(held, { stopReason: 'cancelled' });
    held = undefined;
  } else if (id !== undefined) error(id, -32601);
}
