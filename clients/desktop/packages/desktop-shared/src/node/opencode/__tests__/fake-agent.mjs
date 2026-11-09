import readline from 'node:readline';
import { loadOpenCodeV2FixturePlugin } from '../../../../../../scripts/test-support/opencode-v2-plugin.mjs';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Accelerate the generated plugin's deadlines for pending-approval coverage.
if (process.env.OPENCODE_FIXTURE_FAST_TIMEOUTS) {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (milliseconds) =>
    timeout(Math.ceil(milliseconds / 1000));
}
// Mirror the pinned CLI's raw-text substitutions before parsing the runtime config.
let configText = process.env.OPENCODE_CONFIG_CONTENT.replace(
  /\{env:([^}]+)\}/g,
  (_, name) => process.env[name] || '',
);
for (const match of [...configText.matchAll(/\{file:([^}]+)\}/g)])
  configText = configText.replace(
    match[0],
    JSON.stringify((await readFile(match[1], 'utf8')).trim()).slice(1, -1),
  );
const config = JSON.parse(configText);
let plugin;
async function loadPlugin() {
  plugin ??= await loadOpenCodeV2FixturePlugin(config, {
    missingSession: (id) => id === 'missing',
    accounts: async () => {
      const providerId = (config.model ?? 'fixture/model').split('/')[0];
      const connection = process.env.OPENCODE_FIXTURE_CONNECTION_FILE
        ? JSON.parse(
            await readFile(
              process.env.OPENCODE_FIXTURE_CONNECTION_FILE,
              'utf8',
            ),
          )
        : {
            type: 'credential',
            id: process.env.OPENCODE_FIXTURE_CONNECTION_ID ?? 'cred_fixture',
            label:
              process.env.OPENCODE_FIXTURE_CONNECTION_LABEL ??
              'Fixture account',
            method: 'oauth',
          };
      return {
        providers: [{ id: providerId, name: 'Fixture' }],
        integrations: [
          { id: providerId, connections: connection ? [connection] : [] },
        ],
        active: { [providerId]: connection },
      };
    },
  });
}
if (!process.env.OPENCODE_FIXTURE_LAZY_PLUGIN) await loadPlugin();
const beforeTool = (...args) => plugin.beforeTool(...args);
const beforeShell = (...args) => plugin.beforeShell(...args);
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const error = (id, code = -32602, message = 'fixture error') =>
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }) + '\n',
  );
const configuredModel = config.model ?? 'fixture/model';
let selected = configuredModel;
let effort = 'medium';
const effortMode = process.env.OPENCODE_FIXTURE_EFFORT;
let sessionId = process.env.OPENCODE_FIXTURE_SESSION_ID || 'opencode-fixture';
let loaded = false;
let held;
const options = () => [
  ...(effortMode && effortMode !== 'absent'
    ? [
        {
          id: 'effort',
          name: 'Effort',
          type: 'select',
          currentValue: effort,
          options: ['medium', 'high'].map((value) => ({ name: value, value })),
        },
      ]
    : []),
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: selected,
    options: [{ value: configuredModel, name: 'Fixture model' }],
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
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (process.env.OPENCODE_FIXTURE_LIFECYCLE_LOG)
    await appendFile(
      process.env.OPENCODE_FIXTURE_LIFECYCLE_LOG,
      JSON.stringify({ method, sessionId: params?.sessionId }) + '\n',
    );
  if (method === 'initialize')
    reply(id, {
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.0.32' },
      agentCapabilities: {
        loadSession: process.env.OPENCODE_FIXTURE_LOAD !== 'unsupported',
        sessionCapabilities: { list: {}, delete: {} },
        mcpCapabilities: { http: true },
        promptCapabilities:
          process.env.OPENCODE_FIXTURE_PROMPT_CONTENT === 'disabled'
            ? {}
            : { image: true, embeddedContext: true },
      },
    });
  else if (method === 'session/delete') reply(id, {});
  else if (method === 'session/list') {
    reply(
      id,
      params.cursor
        ? { sessions: [{ sessionId: 'transient', cwd: process.cwd() }] }
        : { sessions: [], nextCursor: 'last-page' },
    );
  } else if (method === 'session/new') {
    await loadPlugin();
    if (loaded) sessionId = 'opencode-fixture';
    if (existsSync(path.join(params.cwd, '.opencode-fixture-fail-session')))
      error(id, -32603, 'fixture provider authentication failed');
    else {
      await plugin.registerMcpServers(params.mcpServers);
      reply(id, { sessionId, configOptions: options() });
    }
  } else if (method === 'session/load') {
    loaded = true;
    if (params.sessionId === 'missing' || params.sessionId === 'transient')
      error(id, -32603);
    else {
      await loadPlugin();
      await plugin.registerMcpServers(params.mcpServers);
      sessionId = params.sessionId;
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Replayed history must not appear twice.',
        },
      });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'old-write',
        title: 'write',
        kind: 'edit',
        status: 'completed',
      });
      reply(id, { configOptions: options() });
    }
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'effort') {
      if (effortMode !== 'mismatch') effort = params.value;
      if (effortMode === 'snap-model') selected = 'fixture/other';
      reply(id, { configOptions: options() });
    } else if (params.value !== configuredModel) error(id);
    else {
      selected = params.value;
      reply(id, { configOptions: options() });
    }
  } else if (method === 'session/prompt') {
    const text = params.prompt
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.includes('HOLD')) {
      held = id;
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Waiting.' },
      });
      continue;
    }
    let result = 'OpenCode fixture reply.';
    if (text.includes('FORK_SEED_PROBE')) result = text;
    if (text === 'USAGE') {
      update({
        sessionUpdate: 'usage_update',
        used: 1234,
        size: 10000,
        cost: { amount: 100.75, currency: 'USD' },
      });
    }
    if (text === 'PROMPT_CONTENT') {
      await writeFile(path.join(process.cwd(), 'prompt-called'), 'yes');
      result = JSON.stringify(params.prompt.slice(1));
    }
    if (text === 'IGNORED_UPDATES') {
      for (let i = 0; i < 80; i++)
        update({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'SECRET-command', description: 'SECRET-description' },
          ],
        });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'U0VDUkVU',
          mimeType: 'image/png',
          uri: 'file:///SECRET.png',
        },
      });
    }

    if (text === 'CONFIG_PROVIDER') result = JSON.stringify(config.provider);
    if (text === 'CONFIG_INFERENCE')
      result = JSON.stringify({
        provider: config.provider,
        model: config.model,
        smallModel: config.small_model,
        enabledProviders: config.enabled_providers,
        auth: process.env.OPENCODE_AUTH_CONTENT,
      });
    if (text === 'SHELL_ENV') {
      await beforeTool(
        { sessionID: sessionId, callID: 'shell-env', tool: 'shell' },
        { args: { command: 'read fixture CLI configuration' } },
      );
      const shell = { env: {} };
      await beforeShell({ cwd: process.cwd() }, shell);
      // Match pinned OpenCode's merge before a native shell subprocess.
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '-e',
          `
          const fs = require('node:fs');
          const path = require('node:path');
          const root = process.env.XDG_CONFIG_HOME || path.join(require('node:os').homedir(), '.config');
          let config = null;
          try { config = fs.readFileSync(path.join(root, 'gh', 'hosts.yml'), 'utf8'); } catch {}
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(path.join(root, 'shell-created.txt'), 'persisted');
          process.stdout.write(JSON.stringify({
            config,
            roots: ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].map(key => process.env[key] ?? null),
          }));
        `,
        ],
        { cwd: process.cwd(), env: { ...process.env, ...shell.env } },
      );
      result = JSON.stringify({
        ...JSON.parse(stdout),
        runtimeIsolated:
          process.env.XDG_CONFIG_HOME === process.env.OPENCODE_CONFIG_DIR &&
          process.env.XDG_STATE_HOME ===
            path.join(path.dirname(process.env.OPENCODE_CONFIG_DIR), 'state') &&
          process.env.XDG_CACHE_HOME ===
            path.join(path.dirname(process.env.OPENCODE_CONFIG_DIR), 'cache'),
      });
    }
    if (text === 'CONFIG_SOURCES') {
      const profile = path.dirname(process.env.OPENCODE_CONFIG_DIR);
      result =
        process.env.OPENCODE_DB !== 'untrusted-native.db' &&
        !process.env.OPENCODE_DB.startsWith(profile + path.sep) &&
        process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR ===
          process.env.OPENCODE_CONFIG_DIR
          ? 'Configuration isolated.'
          : 'Inherited configuration.';
    }

    if (text.includes('DUPLICATE')) {
      const attempts = await Promise.allSettled(
        [1, 2].map(() =>
          beforeTool(
            { sessionID: sessionId, callID: 'same-call', tool: 'write' },
            { args: { path: '/tmp/test', content: 'x' } },
          ),
        ),
      );
      result = `Approved attempts: ${attempts.filter((entry) => entry.status === 'fulfilled').length}`;
    }
    if (text.includes('UNAPPROVED')) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'rogue',
        title: 'write',
        kind: 'edit',
        status: 'completed',
      });
      continue;
    }
    if (
      [
        'opencode_list_mcp_resources',
        'list_mcp_resource_templates',
        'opencode_read_mcp_resource',
      ].includes(text)
    ) {
      const args = { server: 'original', uri: 'resource://original' };

      try {
        await beforeTool(
          { sessionID: sessionId, callID: 'resource-1', tool: text },
          { args },
        );
        await writeFile(
          path.join(process.cwd(), 'resource-executed.txt'),
          args.server,
        );
        result = 'Resource allowed.';
      } catch {
        result = 'Resource denied.';
      }
    }
    if (text.includes('WRITE')) {
      const filePath = path.join(process.cwd(), 'sentinel.txt');
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
        result = 'Write allowed.';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'completed',
          rawOutput: 'written',
        });
      } catch {
        result = 'Write denied.';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'write-1',
          status: 'failed',
          rawOutput: 'denied',
        });
      }
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
      ...(text === 'USAGE'
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
