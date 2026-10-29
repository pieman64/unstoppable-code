import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

/** List each ACP MCP server's tools under v2's normalized native tool ids. */
async function listMcpTools(servers) {
  if (!servers.length) return [];
  // Most fixture sessions select no servers; load the MCP client only when needed.
  const [
    { Client },
    { StdioClientTransport },
    { StreamableHTTPClientTransport },
  ] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ]);
  const native = (name) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const entries = (list) =>
    Object.fromEntries(list.map((entry) => [entry.name, entry.value]));
  const tools = [];
  for (const server of servers) {
    const client = new Client({ name: 'opencode-fixture', version: '1' });
    try {
      await client.connect(
        'url' in server
          ? new StreamableHTTPClientTransport(new URL(server.url), {
              requestInit: { headers: entries(server.headers) },
            })
          : new StdioClientTransport({
              command: server.command,
              args: server.args,
              env: entries(server.env),
              stderr: 'ignore',
            }),
      );
      const listed = [];
      let cursor;
      let pages = 0;
      do {
        // Match the host discovery cap so a looping cursor cannot hang the agent.
        if (++pages > 100)
          throw new Error('The tool catalog has too many pages.');
        const page = await client.listTools(cursor ? { cursor } : {});
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      for (const tool of listed)
        tools.push({
          id: `${native(server.name)}_${native(tool.name)}`,
          description: tool.description ?? '',
          input: tool.inputSchema,
        });
    } catch (error) {
      // V2 marks a failed server and keeps the session without its tools.
      process.stderr.write(
        `OpenCode fixture could not list MCP server ${server.name}: ${error.message}\n`,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  return tools;
}

/** Exercise the generated plugin through the pinned v2 setup and hook contracts. */
export async function loadOpenCodeV2FixturePlugin(config, options = {}) {
  const directory = fileURLToPath(config.plugins[0]);
  const { default: plugin } = await import(
    pathToFileURL(path.join(directory, 'index.js')).href
  );
  const hooks = new Map();
  let mcpTools = [];
  const transform = (editor) =>
    editor({ list: () => [], update: () => undefined });
  await plugin.setup({
    app: { version: '2.0.32' },
    location: { directory: process.cwd() },
    agent: { transform },
    mcp: { transform },
    tool: {
      transform,
      hook: (name, callback) => hooks.set(`tool.${name}`, callback),
      list: async () => mcpTools,
    },
    shell: { hook: (name, callback) => hooks.set(`shell.${name}`, callback) },
    model: { list: async () => options.models ?? [] },
    provider: {
      list: async () => ({
        data: (await options.accounts?.())?.providers ?? [],
      }),
    },
    integration: {
      list: async () => ({
        data: (await options.accounts?.())?.integrations ?? [],
      }),
      connection: {
        active: async (id) => (await options.accounts?.())?.active?.[id],
        resolve: () => {
          throw new Error('Account metadata must never resolve credentials');
        },
      },
    },
    session: {
      context: options.session?.context,
      move: options.session?.move,
      remove: options.session?.remove,
      get: async ({ sessionID }) => {
        if (options.missingSession?.(sessionID))
          throw Object.assign(new Error('Missing session'), {
            _tag: 'SessionNotFoundError',
          });
        return options.session?.get
          ? options.session.get({ sessionID })
          : { id: sessionID };
      },
    },
  });
  return {
    /** V2 registers each session's ACP MCP servers as native tools. */
    async registerMcpServers(servers) {
      mcpTools = await listMcpTools(servers);
    },
    async beforeTool(input, output) {
      const event = {
        tool: input.tool,
        sessionID: input.sessionID,
        id: input.callID,
        input: output.args,
      };
      await hooks.get('tool.execute.before')(event);
      // Fixture execution below reads this object after the hook, as v2 reads event.input.
      if (event.input !== output.args) {
        for (const key of Object.keys(output.args)) delete output.args[key];
        Object.assign(output.args, event.input);
      }
    },
    async beforeShell(_input, output) {
      await hooks.get('shell.create.before')(output);
    },
  };
}
