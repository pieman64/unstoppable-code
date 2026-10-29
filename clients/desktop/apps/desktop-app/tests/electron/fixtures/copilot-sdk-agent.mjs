// Deterministic native CLI boundary fixture. The production SDK transports all calls.
import net from 'node:net';
const presentationModels = [];
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const state = process.env.COPILOT_HOME;
await mkdir(state, { recursive: true });
const read = async (file, fallback) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};
// The runtime never has an identity of its own: every call carries the token
// the host acquired through the GitHub App, and the fake derives the login
// from it the way the mock GitHub server keys its scenarios.
const loginFromToken = (token) => {
  if (typeof token !== 'string' || !token.startsWith('ghu_e2e_'))
    throw new Error('Failed to fetch Copilot user info: 401 Unauthorized');
  return token.slice('ghu_e2e_'.length);
};
// Replaced only by the fixture packager; ordinary runs use default quotas.
const quotaFixtureFile = '';
const sessions = new Map();
async function httpMcpRpc(serverConfig) {
  const headers = {
    ...serverConfig.headers,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const rpc = async (method, params) => {
    const response = await fetch(serverConfig.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method,
        params,
      }),
    });
    if (!response.ok) throw new Error(`MCP fixture HTTP ${response.status}`);
    const session = response.headers.get('mcp-session-id');
    if (session) headers['Mcp-Session-Id'] = session;
    const text = await response.text();
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
  return { rpc, close: async () => undefined };
}
const mcpChannels = new Set();
function stdioMcpRpc(config) {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd,
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  const rejectPending = (error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.stdin.on('error', rejectPending);
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    } catch (error) {
      rejectPending(error);
    }
  });
  const exited = new Promise((resolve) =>
    child.once('close', () => {
      lines.close();
      rejectPending(new Error('MCP fixture process closed'));
      resolve();
    }),
  );
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP fixture timed out: ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  const close = async () => {
    child.stdin.end();
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  return { rpc, close };
}
async function connectMcp(serverConfig) {
  const channel = serverConfig.command
    ? stdioMcpRpc(serverConfig)
    : await httpMcpRpc(serverConfig);
  mcpChannels.add(channel);
  try {
    await channel.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'copilot-fixture', version: '1' },
    });
    const listed = await channel.rpc('tools/list', {});
    return { ...channel, tools: listed.tools };
  } catch (error) {
    mcpChannels.delete(channel);
    await channel.close();
    throw error;
  }
}
async function closeMcpChannels() {
  const channels = [...mcpChannels];
  mcpChannels.clear();
  await Promise.all(channels.map((channel) => channel.close()));
}
process.once('SIGTERM', () => {
  void closeMcpChannels().finally(() => process.exit(0));
});
const initializedTools = new Map();
async function initializeTools(sessionId) {
  if (initializedTools.has(sessionId)) return initializedTools.get(sessionId);
  const config = sessions.get(sessionId);
  if (!config) throw new Error('Unknown fixture session');
  const result = { channels: new Map(), servers: [], tools: [] };
  for (const [name, serverConfig] of Object.entries(config.mcpServers ?? {})) {
    try {
      const channel = await connectMcp(serverConfig);
      result.channels.set(name, channel);
      result.servers.push({ name, status: 'connected' });
      for (const tool of channel.tools) {
        if (
          !(serverConfig.tools ?? ['*']).some(
            (selected) => selected === '*' || selected === tool.name,
          )
        )
          continue;
        result.tools.push({
          name: `${name}-${tool.name}`,
          mcpServerName: name,
          mcpToolName: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        });
      }
    } catch (error) {
      result.servers.push({ name, status: 'failed', error: error.message });
    }
  }
  initializedTools.set(sessionId, result);
  return result;
}
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0),
    sequence = 0;
  const pending = new Map();
  const send = (value) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value }));
    socket.write(`Content-Length: ${body.length}\r\n\r\n`);
    socket.write(body);
  };
  const ask = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `fixture-${++sequence}`;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const event = (sessionId, type, data) =>
    send({
      method: 'session.event',
      params: {
        sessionId,
        event: {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          parentId: null,
          ephemeral: false,
          type,
          data,
        },
      },
    });
  const run = async ({ sessionId, prompt }) => {
    const config = sessions.get(sessionId);
    const savedFile = path.join(config.configDir, 'fixture-session.json');
    const saved = await read(savedFile, { turns: 0 });
    saved.turns++;
    await writeFile(savedFile, JSON.stringify(saved));
    if (prompt.includes('COPILOT_HOLD')) {
      event(sessionId, 'assistant.message_delta', {
        messageId: 'waiting',
        deltaContent: 'Waiting for Stop.',
      });
      return;
    }
    let answer = `Copilot fixture reply ${saved.turns}.`;
    if (prompt.includes('COPILOT_HOME_NOTICE_FOLLOWUP'))
      answer = 'Home notice follow-up completed.';
    if (prompt.includes('COPILOT_UNAUTHORIZED_COMPLETION')) {
      const toolCallId = randomUUID();
      event(sessionId, 'tool.execution_start', {
        toolCallId,
        toolName: 'create',
        arguments: {
          path: path.join(config.workingDirectory, 'unapproved.txt'),
          file_text: 'not actually written',
        },
      });
      // Deliberately violate the vendor hook contract without performing a side effect.
      event(sessionId, 'tool.execution_complete', {
        toolCallId,
        success: true,
        result: { content: 'Written' },
      });
      answer = 'Unauthorized completion accepted.';
    }
    if (prompt.includes('COPILOT_WRITE')) {
      const toolCallId = randomUUID();
      const toolArgs = {
        path: path.join(config.workingDirectory, 'copilot-sentinel.txt'),
        file_text: 'authorized fixture write',
      };
      event(sessionId, 'tool.execution_start', {
        toolCallId,
        toolName: 'create',
        arguments: toolArgs,
      });
      const decision = await ask('hooks.invoke', {
        sessionId,
        hookType: 'preToolUse',
        input: {
          timestamp: Date.now(),
          cwd: config.workingDirectory,
          toolName: 'create',
          toolArgs,
        },
      });
      const allowed = decision.output?.permissionDecision === 'allow';
      if (allowed) await writeFile(toolArgs.path, toolArgs.file_text);
      event(sessionId, 'tool.execution_complete', {
        toolCallId,
        success: allowed,
        result: { content: allowed ? 'Written' : 'Denied' },
      });
      answer = allowed ? 'Copilot write allowed.' : 'Copilot write denied.';
    }
    const appTool = async (name, toolArgs, prepareOnly = false) => {
      const initialized = await initializeTools(sessionId);
      const match = [...initialized.channels].find(
        ([server, channel]) =>
          (name !== 'AskUserQuestion' || server.endsWith('_ui')) &&
          channel.tools.some((tool) => tool.name === name),
      );
      if (!match)
        throw new Error(`Expected app tool ${name} was not projected`);
      const [serverName, { rpc, tools }] = match;
      const tool = tools.find((entry) => entry.name === name);
      const toolName = `${serverName}-${tool.name}`;
      const toolCallId = randomUUID();
      event(sessionId, 'tool.execution_start', {
        toolCallId,
        toolName,
        arguments: toolArgs,
        mcpServerName: serverName,
        mcpConfigServerName: serverName,
        mcpToolName: tool.name,
      });
      const decision = await ask('hooks.invoke', {
        sessionId,
        hookType: 'preToolUse',
        input: {
          timestamp: Date.now(),
          cwd: config.workingDirectory,
          toolName,
          toolArgs,
        },
      });
      if (decision.output?.permissionDecision !== 'allow')
        throw new Error('App MCP call denied');
      const invoke = async () => {
        const result = await rpc('tools/call', {
          name: tool.name,
          arguments: toolArgs,
        });
        const text = result.content
          .filter((entry) => entry.type === 'text')
          .map((entry) => entry.text)
          .join('\n');
        if (result.isError) throw new Error(`App MCP tool failed: ${text}`);
        if (name === 'LoadDeferredTools') {
          const loaded = JSON.parse(text);
          if (!loaded.willEnable?.length)
            throw new Error('No capability accepted');
          saved.deferredLoadAccepted = { sessionId };
          await writeFile(savedFile, JSON.stringify(saved));
        }
        event(sessionId, 'tool.execution_complete', {
          toolCallId,
          success: true,
          result: {
            content: text,
            detailedContent: text,
            contents: result.content,
          },
        });
        return text;
      };
      return prepareOnly ? invoke : invoke();
    };
    const managedForkChild =
      config.systemMessage?.content?.includes('COPILOT_MANAGED_FORK_CHILD') ||
      (prompt.includes('<forked_conversation>') &&
        prompt.includes('COPILOT_MANAGED_FORK_SOURCE'));
    if (managedForkChild) {
      if (
        !prompt.includes('<forked_conversation>') ||
        !prompt.includes('COPILOT_MANAGED_FORK_CANARY')
      )
        throw new Error('Managed Copilot fork missed the frozen conversation');
      answer = 'Copilot independent child retained the conversation.';
    } else if (prompt.includes('COPILOT_MANAGED_FORK_SOURCE')) {
      const branched = prompt.includes('COPILOT_MANAGED_BRANCH');
      const reply = JSON.parse(
        await appTool(branched ? 'StartBranchedAgent' : 'StartForkedAgent', {
          followUpInstruction:
            'COPILOT_MANAGED_FORK_CHILD: Report the retained conversation.',
        }),
      );
      if (!reply.ok || !reply.independent || !reply.chatId || !reply.worktreeId)
        throw new Error('Managed fork was not accepted');
      answer = 'Copilot source continued after starting its independent child.';
    }
    if (prompt.includes('COPILOT_COWORK_DISPATCH_SCHEMA')) {
      const initialized = await initializeTools(sessionId);
      const dispatch = initialized.tools.find(
        (tool) => tool.mcpToolName === 'DispatchAction',
      );
      if (
        !dispatch ||
        JSON.stringify(dispatch.input_schema).includes('"new_worktree"')
      )
        throw new Error('Copilot Cowork advertised a worktree-only placement');
      answer = 'Copilot Cowork dispatch uses only Cowork placements.';
    }
    if (prompt.includes('COPILOT_DEFERRED_POLICY')) {
      const initialized = await initializeTools(sessionId);
      const names = initialized.tools.map((tool) => tool.mcpToolName);
      const enabled = prompt.includes('COPILOT_DEFERRED_POLICY_ENABLED');
      for (const name of ['SearchDeferredTools', 'LoadDeferredTools']) {
        if (names.includes(name) !== enabled)
          throw new Error(`Deferred policy ${enabled} did not match ${name}`);
      }
      answer = enabled
        ? 'Copilot deferred discovery is enabled.'
        : 'Copilot deferred discovery is disabled.';
    }
    if (prompt.includes('COPILOT_DEFERRED_LOAD')) {
      const found = JSON.parse(
        await appTool('SearchDeferredTools', {
          queries: [{ text: 'Deferred Reload Fixture', kinds: ['mcp'] }],
        }),
      );
      if (found.provider !== 'copilot')
        throw new Error('Wrong deferred provider');
      const ref = found.results[0]?.matches[0]?.ref;
      if (!ref) throw new Error('No installed fixture found');
      const args = { items: [{ ref }] };
      if (prompt.includes('COPILOT_DEFERRED_LOAD_DUPLICATE')) {
        const first = await appTool('LoadDeferredTools', args, true);
        let second;
        try {
          second = await appTool('LoadDeferredTools', args, true);
        } catch (error) {
          if (error.message !== 'App MCP call denied') throw error;
        }
        // Reverse HTTP arrival after both native approvals. The host must
        // reject the ambiguous second call before it reaches the executor.
        if (second) await second();
        await first();
      } else {
        await appTool('LoadDeferredTools', args);
      }
      // The host must synchronously stop projection of this old turn once
      // the native receipt arrives, even if the runtime races another event.
      event(sessionId, 'assistant.message_delta', {
        messageId: 'after-load',
        deltaContent: 'OLD_TURN_SHOULD_NOT_CONTINUE',
      });
      return;
    }
    if (
      saved.deferredLoadAccepted &&
      prompt.includes('Requested items now enabled')
    ) {
      if (saved.deferredLoadAccepted.sessionId !== sessionId)
        throw new Error('Reload created a different conversation');
      if (saved.deferredResumed)
        throw new Error('Duplicate deferred continuation');
      saved.deferredResumed = true;
      await writeFile(savedFile, JSON.stringify(saved));
      await appTool('deferred_echo', { message: 'copilot after reload' });
      answer = 'Copilot loaded and resumed once.';
    }
    if (prompt.includes('COPILOT_PIPELINE_MCP')) {
      await appTool('deferred_echo', {
        message: 'copilot-pipeline-approval-sentinel',
      });
      answer = 'Copilot pipeline MCP completed.';
    }
    if (prompt.includes('COPILOT_APP_TOOL')) {
      await appTool('GetGitPreferences', { type: 'branch-name' });
      answer = 'Copilot app tool completed.';
    }
    if (prompt.includes('COPILOT_CODE_GRAPH')) {
      await appTool('GetCodeGraphContext', {});
      answer = 'Copilot inspected the code graph.';
    }
    if (prompt.includes('COPILOT_SELECTED_SKILL')) {
      const sentinel = prompt.includes('COPILOT_SELECTED_SKILL_UPDATED')
        ? 'COPILOT_CHANGED_SKILL_SENTINEL_'
        : 'COPILOT_PIPELINE_SKILL_SENTINEL';
      const roots = config.skillDirectories ?? [];
      let found = false;
      for (const root of roots) {
        for (const name of await readdir(root)) {
          const text = await readFile(
            path.join(root, name, 'SKILL.md'),
            'utf8',
          );
          if (text.includes(sentinel)) found = true;
        }
      }
      if (!found)
        throw new Error(
          `Selected pipeline skill was not projected: ${JSON.stringify(roots)}`,
        );
      answer = 'Copilot loaded its selected pipeline skill.';
    }
    if (prompt.includes('COPILOT_GRAPH_ACTION')) {
      const response = JSON.parse(
        await appTool('DispatchAction', {
          action: {
            type: 'code-graph.get_context',
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
          },
        }),
      );
      if (!response.ok || !response.result?.text?.includes('hasGraph')) {
        throw new Error(
          'Advisor graph action did not reach the worktree executor',
        );
      }
      answer = 'Copilot Advisor inspected the worktree graph.';
    }
    if (prompt.includes('COPILOT_ADVISOR')) {
      await appTool('GetCurrentUiState', {});
      answer = 'Copilot Advisor inspected the app.';
    }
    if (prompt.includes('COPILOT_MCP_ASK')) {
      const response = await appTool('AskUserQuestion', {
        questions: [
          { question: 'Choose the fixture color', options: ['Blue', 'Green'] },
        ],
      });
      if (!response.includes('Green'))
        throw new Error('Selected answer did not reach the MCP tool');
      answer = 'Selected Green.';
    }

    if (prompt.includes('COPILOT_FORK_ASSERT')) {
      const context = prompt.match(
        /<forked_conversation>([\s\S]*?)<\/forked_conversation>/,
      )?.[1];
      if (!saved.forkContextSeen) {
        if (!context?.includes('COPILOT_FORK_HISTORY_CANARY'))
          throw new Error('Copilot fork did not receive the selected history');
        if (context.includes('COPILOT_FUTURE_SOURCE_CANARY'))
          throw new Error('Copilot fork received later source history');
        saved.forkContextSeen = true;
        await writeFile(savedFile, JSON.stringify(saved));
        answer = 'Copilot fork inherited selected history.';
      } else {
        if (context)
          throw new Error('Copilot fork received duplicate history on resume');
        answer = 'Copilot fork reused native history.';
      }
    }

    if (
      prompt.includes('COPILOT_DELEGATION_PARENT') ||
      prompt.includes('COPILOT_HOME_PARENT') ||
      prompt.includes('COPILOT_PLUGIN_HOME_PARENT')
    ) {
      if (prompt.includes('MCP_SELECTOR_DRIFT')) {
        const match = /MCP_SELECTOR_FILE=([^\s:]+)/.exec(prompt);
        if (!match) throw new Error('Missing selector fixture path');
        const file = decodeURIComponent(match[1]);
        const plugin = JSON.parse(await readFile(file, 'utf8'));
        plugin.mcpServers.review.env_http_headers.Authorization =
          'COPILOT_PIN_PRIVATE_SECRET';
        await writeFile(file, JSON.stringify(plugin));
      }
      const response = JSON.parse(
        await appTool('DelegateTask', {
          model: prompt.includes('HOME_BUDGET')
            ? 'agent_model_copilot_home_budget'
            : 'copilot:fixture-model',
          description: 'Read delegated evidence',
          prompt: prompt.includes('COPILOT_PLUGIN_HOME_PARENT')
            ? prompt.includes('HOME_OPT_OUT')
              ? 'COPILOT_PLUGIN_HOME_CHILD_OPT_OUT'
              : 'COPILOT_PLUGIN_HOME_CHILD'
            : prompt.includes('COPILOT_HOME_PARENT')
              ? prompt.includes('HOME_OPT_OUT')
                ? 'COPILOT_HOME_CHILD_OPT_OUT'
                : 'COPILOT_HOME_CHILD'
              : 'COPILOT_CHILD_READ',
          ...(prompt.includes('HOME_OPT_OUT')
            ? { inherit_capabilities: false }
            : {}),
        }),
      );
      if (!response.ok) throw new Error('Delegate launch failed');
      saved.delegationId = response.value.delegationId;
      await writeFile(savedFile, JSON.stringify(saved));
      if (prompt.includes('MCP_SELECTOR_DRIFT')) {
        // Observe the child in this parent turn. A watcher starts a new parent
        // turn, which legitimately reloads the changed installed configuration
        // and would mix parent traffic into the child's credential assertion.
        const deadline = Date.now() + 60000;
        let settled;
        while (Date.now() < deadline) {
          const result = JSON.parse(
            await appTool('GetDelegateOutput', {
              delegationId: saved.delegationId,
            }),
          );
          if (result.ok && result.value?.latestResultIndex) {
            settled = result;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!settled) throw new Error('Selector fixture child did not settle');
        answer = `Integrated Copilot child: ${JSON.stringify(settled)}`;
      } else {
        await appTool('WatchDelegates', {
          delegationIds: [saved.delegationId],
          mode: 'all',
          timeoutMs: 60000,
        });
        answer = 'Waiting for delegated evidence.';
      }
    } else if (
      saved.delegationId &&
      !prompt.includes('COPILOT_HOME_NOTICE_FOLLOWUP')
    ) {
      const result = await appTool('GetDelegateOutput', {
        delegationId: saved.delegationId,
      });
      answer = `Integrated Copilot child: ${result}`;
    }
    if (prompt.includes('COPILOT_PLUGIN_HOME_CHILD')) {
      const texts = [];
      for (const root of config.skillDirectories ?? [])
        for (const name of await readdir(root)) {
          const file = path.join(root, name, 'SKILL.md');
          const text = await readFile(file, 'utf8');
          if (!text.includes('COPILOT_INSTALLED_PLUGIN_CANARY')) continue;
          const toolCallId = randomUUID();
          event(sessionId, 'tool.execution_start', {
            toolCallId,
            toolName: 'view',
            arguments: { path: file },
          });
          const permission = await ask('hooks.invoke', {
            sessionId,
            hookType: 'preToolUse',
            input: {
              timestamp: Date.now(),
              cwd: config.workingDirectory,
              toolName: 'view',
              toolArgs: { path: file },
            },
          });
          if (permission.output?.permissionDecision !== 'allow')
            throw Error('Installed plugin read denied');
          event(sessionId, 'tool.execution_complete', {
            toolCallId,
            success: true,
            result: { content: text },
          });
          texts.push(text);
        }
      const initialized = await initializeTools(sessionId);
      const hasTool = initialized.tools.some(
        (tool) => tool.mcpToolName === 'deferred_echo',
      );
      if (prompt.includes('OPT_OUT')) {
        if (texts.length || hasTool)
          throw Error('Installed plugin escaped opt-out');
        answer = 'Installed plugin inheritance is disabled.';
      } else {
        if (texts.length !== 1 || !hasTool)
          throw Error('Installed plugin content or MCP is missing');
        await appTool('deferred_echo', { message: 'installed plugin child' });
        answer = 'Installed plugin content and MCP retained.';
      }
    }
    if (prompt.includes('COPILOT_HOME_CHILD')) {
      const roots = config.skillDirectories ?? [];
      const contents = [];
      for (const root of roots) {
        for (const name of await readdir(root)) {
          const file = path.join(root, name, 'SKILL.md');
          const text = await readFile(file, 'utf8');
          if (!text.includes('COPILOT_HOME_DELEGATE_CANARY')) continue;
          const toolCallId = randomUUID();
          event(sessionId, 'tool.execution_start', {
            toolCallId,
            toolName: 'view',
            arguments: { path: file },
          });
          const permission = await ask('hooks.invoke', {
            sessionId,
            hookType: 'preToolUse',
            input: {
              timestamp: Date.now(),
              cwd: config.workingDirectory,
              toolName: 'view',
              toolArgs: { path: file },
            },
          });
          if (permission.output?.permissionDecision !== 'allow')
            throw Error('Retained home skill read denied');
          event(sessionId, 'tool.execution_complete', {
            toolCallId,
            success: true,
            result: { content: text },
          });
          contents.push(text);
        }
      }
      if (prompt.includes('COPILOT_HOME_CHILD_OPT_OUT')) {
        if (contents.length)
          throw Error('Opted-out child inherited home skill');
        answer = 'Copilot home inheritance is disabled for this child.';
      } else {
        if (contents.length !== 1)
          throw Error('Child did not inherit its parent home skill');
        answer = 'COPILOT_HOME_DELEGATE_CANARY retained and readable.';
      }
    }
    if (prompt.includes('COPILOT_CHILD_READ')) {
      const toolCallId = randomUUID();
      const toolArgs = {
        path: path.join(config.workingDirectory, 'delegation-evidence.txt'),
      };
      event(sessionId, 'tool.execution_start', {
        toolCallId,
        toolName: 'view',
        arguments: toolArgs,
      });
      const decision = await ask('hooks.invoke', {
        sessionId,
        hookType: 'preToolUse',
        input: {
          timestamp: Date.now(),
          cwd: config.workingDirectory,
          toolName: 'view',
          toolArgs,
        },
      });
      if (decision.output?.permissionDecision !== 'allow')
        throw new Error('Child read denied');
      answer = await readFile(toolArgs.path, 'utf8');
      event(sessionId, 'tool.execution_complete', {
        toolCallId,
        success: true,
        result: { content: answer },
      });
    }
    if (prompt.includes('COPILOT_ASK')) {
      const toolCallId = randomUUID();
      const toolArgs = {
        question: 'Choose the fixture color',
        choices: ['Blue', 'Green'],
        allowFreeform: true,
      };
      event(sessionId, 'tool.execution_start', {
        toolCallId,
        toolName: 'ask_user',
        arguments: toolArgs,
      });
      const permission = await ask('hooks.invoke', {
        sessionId,
        hookType: 'preToolUse',
        input: {
          timestamp: Date.now(),
          cwd: config.workingDirectory,
          toolName: 'ask_user',
          toolArgs,
        },
      });
      if (permission.output?.permissionDecision !== 'allow')
        throw new Error('Question denied');
      const decision = await ask('userInput.request', {
        sessionId,
        ...toolArgs,
      });
      event(sessionId, 'tool.execution_complete', {
        toolCallId,
        success: true,
        result: { content: decision.answer },
      });
      answer = `Selected ${decision.answer}.`;
    }
    event(sessionId, 'assistant.message_delta', {
      messageId: 'reply',
      deltaContent: answer.slice(0, 8),
    });
    event(sessionId, 'assistant.message_delta', {
      messageId: 'reply',
      deltaContent: answer.slice(8),
    });
    event(sessionId, 'assistant.message', {
      messageId: 'reply',
      content: answer,
    });
    event(sessionId, 'assistant.usage', {
      model: config.model,
      inputTokens: 10,
      outputTokens: 4,
    });
    event(sessionId, 'session.idle', {});
  };
  const handle = async (message) => {
    if (!message.method) {
      const wait = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) wait?.reject(new Error(message.error.message));
      else wait?.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    let result;
    switch (message.method) {
      case 'connect':
        if (params.token !== process.env.COPILOT_CONNECTION_TOKEN)
          throw new Error('Wrong connection token');
        result = { protocolVersion: 3 };
        break;
      case 'ping':
        result = { protocolVersion: 3, message: params.message };
        break;
      case 'status.get':
        result = { version: '1.0.89', protocolVersion: 3 };
        break;
      case 'auth.getStatus':
        result = { isAuthenticated: false };
        break;
      case 'runtime.shutdown':
        await closeMcpChannels();
        send({ id: message.id, result: {} });
        socket.end();
        server.close(() => process.exit(0));
        return;
      case 'account.getQuota': {
        loginFromToken(params.gitHubToken);
        const quota = quotaFixtureFile
          ? await read(quotaFixtureFile, null)
          : null;
        if (quota !== null) {
          result = { quotaSnapshots: quota };
          break;
        }
        const nextReset = new Date();
        nextReset.setUTCMonth(nextReset.getUTCMonth() + 1, 1);
        nextReset.setUTCHours(0, 0, 0, 0);
        result = {
          quotaSnapshots: {
            premium_interactions: {
              isUnlimitedEntitlement: false,
              entitlementRequests: 100,
              usedRequests: 25,
              remainingPercentage: 75,
              overage: 0,
              usageAllowedWithExhaustedQuota: false,
              overageAllowedWithExhaustedQuota: false,
              resetDate: nextReset.toISOString(),
            },
          },
        };
        break;
      }
      case 'models.list':
        // A seat whose organization policy disables Copilot CLI: the real
        // runtime folds the service's 403 into the request error text.
        if (loginFromToken(params.gitHubToken) === 'policy-blocked')
          throw new Error(
            'Request models.list failed with message: GenericFailure, {"kind":"http","status":403,"statusText":"Forbidden","body":"unauthorized: not authorized to use this Copilot feature\\n","hasRequestId":true}',
          );
        result = {
          models: [
            ...presentationModels,
            {
              id: 'fixture-model',
              name: 'Copilot fixture',
              policy: { state: 'enabled' },
              capabilities: {
                supports: { vision: false, reasoningEffort: true },
                limits: { max_context_window_tokens: 128000 },
              },
              supportedReasoningEfforts: ['low', 'high'],
            },
          ],
        };
        break;
      case 'session.create':
      case 'session.resume': {
        const sessionId = params.sessionId ?? randomUUID();
        await mkdir(params.configDir, { recursive: true });
        if (
          message.method === 'session.resume' &&
          !(await read(
            path.join(params.configDir, 'fixture-session.json'),
            null,
          ))
        )
          throw new Error('Missing conversation');
        if (!params.gitHubTokenProviderRegistrationId)
          throw new Error('Not authenticated. Please authenticate first.');
        const acquired = await ask('gitHubToken.getToken', {
          registrationId: params.gitHubTokenProviderRegistrationId,
          host: 'https://github.com',
          sessionId,
          reason: 'initial',
        });
        if (acquired?.kind !== 'token')
          throw new Error('GitHub token acquisition was cancelled.');
        sessions.set(sessionId, {
          ...params,
          login: loginFromToken(acquired.accessToken),
        });
        result = { sessionId, capabilities: {} };
        break;
      }
      case 'session.tools.initializeAndValidate':
        await initializeTools(params.sessionId);
        result = {};
        break;
      case 'session.tools.getCurrentMetadata':
        result = {
          tools: initializedTools.get(params.sessionId)?.tools ?? null,
        };
        break;
      case 'session.mcp.list':
        result = {
          servers: initializedTools.get(params.sessionId)?.servers ?? [],
        };
        break;
      case 'session.options.update':
        result = {};
        break;
      case 'session.send':
        result = { messageId: randomUUID() };
        send({ id: message.id, result });
        void run(params).catch((error) =>
          event(params.sessionId, 'session.error', { message: error.message }),
        );
        return;
      case 'session.abort':
      case 'session.detach':
        result = {};
        break;
      case 'session.delete':
        for (const channel of initializedTools
          .get(params.sessionId)
          ?.channels.values() ?? [])
          channel.close?.();
        initializedTools.delete(params.sessionId);
        sessions.delete(params.sessionId);
        result = { success: true };
        break;
      default:
        throw new Error(`Unsupported fixture method: ${message.method}`);
    }
    send({ id: message.id, result });
  };
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(
          buffer.subarray(0, boundary).toString(),
        )?.[1],
      );
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 8 * 1024 * 1024
      ) {
        socket.destroy();
        return;
      }
      if (buffer.length < boundary + 4 + length) return;
      const message = JSON.parse(
        buffer.subarray(boundary + 4, boundary + 4 + length).toString(),
      );
      buffer = buffer.subarray(boundary + 4 + length);
      void handle(message).catch((error) =>
        send({
          id: message.id,
          error: { code: -32603, message: error.message },
        }),
      );
    }
  });
  socket.on('error', () => undefined);
  socket.once('close', () => {
    void closeMcpChannels();
  });
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(`Listening on port ${server.address().port}\n`),
);
