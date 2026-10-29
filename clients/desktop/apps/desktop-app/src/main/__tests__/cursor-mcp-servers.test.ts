import { BRAND } from '@canopy/brand/current';
import { buildCursorMcpServers } from '../cursor/mcp-servers';

const ns = BRAND.tools.namespace;
const canopy = {
  mainUrl: 'http://127.0.0.1:4000/canopy/mcp/worktree-session/key',
  uiUrl: 'http://127.0.0.1:4000/canopy/mcp/worktree-session/key/ui',
  authToken: 'secret',
};
const resolveExecutable = (
  command: string,
  cwd?: string,
): Promise<string | null> =>
  Promise.resolve(
    command.startsWith('/')
      ? command === '/bin/missing'
        ? null
        : command
      : command === 'npx'
        ? '/usr/local/bin/npx'
        : command === './bin/server' && cwd
          ? `${cwd}/${command.slice(2)}`
          : null,
  );

describe('buildCursorMcpServers', () => {
  it.each([ns, `${ns}_ui`, `${ns}_app_advisor`, `${ns}_pipeline_editor`])(
    'rejects reserved identity %s in every mode',
    async (name) => {
      await expect(
        buildCursorMcpServers({
          canopy,
          mode: 'app-advisor',
          resolvedMcpServers: {
            [name]: { type: 'http', url: 'https://example.test/mcp' },
          },
          capabilities: { http: true },
          resolveExecutable,
        }),
      ).rejects.toThrow('reserved');
    },
  );

  it('advertises the Canopy main and _ui servers as authenticated HTTP MCP servers', async () => {
    const result = await buildCursorMcpServers({
      canopy,
      resolvedMcpServers: {},
      capabilities: { http: true },
      resolveExecutable,
    });
    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      {
        type: 'http',
        name: ns,
        url: canopy.mainUrl,
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
      {
        type: 'http',
        name: `${ns}_ui`,
        url: canopy.uiUrl,
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      },
    ]);
  });

  it('fails closed without HTTP capability instead of advertising unreachable tools', async () => {
    // The session passes `canopy: null` and owns the app-tools notice when
    // HTTP is not advertised; the translator only reports the plugin servers.
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        remote: { type: 'http', url: 'http://127.0.0.1:5000/mcp' },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([
      'MCP server "remote" needs HTTP MCP support that Cursor did not advertise and was skipped.',
    ]);
  });

  it("notes a definition whose relative path arg will not resolve from Cursor's working directory", async () => {
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        bundled: {
          type: 'stdio',
          command: './bin/server',
          args: ['./config/settings.json'],
          cwd: '/plugins/bundled',
        },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.servers).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([
      'MCP server "bundled" runs in Cursor\'s working directory; its own directory "/plugins/bundled" only locates the executable.',
    ]);
  });

  it('notes a Windows-style relative path arg that stays unresolved', async () => {
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        bundled: {
          type: 'stdio',
          command: './bin/server',
          args: ['.\\config\\settings.json'],
          cwd: '/plugins/bundled',
        },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.notes).toEqual([
      'MCP server "bundled" runs in Cursor\'s working directory; its own directory "/plugins/bundled" only locates the executable.',
    ]);
  });

  it('stays silent for separators in package specifiers, URLs, and flag values', async () => {
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        bundled: {
          type: 'stdio',
          command: 'npx',
          args: [
            '-y',
            '@scope/pkg',
            '--url=https://example.test/mcp',
            '--config=a/b',
          ],
          cwd: '/plugins/bundled',
        },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('stays silent for a cwd definition whose args are already absolute', async () => {
    // The shared plugin resolver makes cwd-relative script paths absolute, so
    // such a server starts fine from Cursor's working directory and the note
    // would only be noise.
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        bundled: {
          type: 'stdio',
          command: '/usr/bin/node',
          args: ['/plugins/bundled/mcp/server.mjs', '--stdio'],
          cwd: '/plugins/bundled',
        },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.servers).toEqual([
      {
        name: 'bundled',
        command: '/usr/bin/node',
        args: ['/plugins/bundled/mcp/server.mjs', '--stdio'],
        env: [],
      },
    ]);
  });

  it('translates resolved plugin and standalone servers into ACP shapes', async () => {
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        proxied: {
          type: 'http',
          url: 'http://127.0.0.1:37645/route',
          headers: undefined,
        },
        direct: {
          type: 'http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: 'Bearer plugin-token', 'X-Team': 'a' },
        },
        events: { type: 'sse', url: 'https://mcp.example.test/sse' },
        local: {
          type: 'stdio',
          command: '/opt/tools/mcp-server',
          args: ['--flag'],
          env: { TOKEN: 'value' },
        },
        viaPath: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      },
      capabilities: { http: true, sse: true },
      resolveExecutable,
    });
    expect(result.warnings).toEqual([]);
    expect(result.servers).toEqual([
      {
        type: 'http',
        name: 'proxied',
        url: 'http://127.0.0.1:37645/route',
        headers: [],
      },
      {
        type: 'http',
        name: 'direct',
        url: 'https://mcp.example.test/mcp',
        headers: [
          { name: 'Authorization', value: 'Bearer plugin-token' },
          { name: 'X-Team', value: 'a' },
        ],
      },
      {
        type: 'sse',
        name: 'events',
        url: 'https://mcp.example.test/sse',
        headers: [],
      },
      {
        name: 'local',
        command: '/opt/tools/mcp-server',
        args: ['--flag'],
        env: [{ name: 'TOKEN', value: 'value' }],
      },
      {
        name: 'viaPath',
        command: '/usr/local/bin/npx',
        args: ['-y', 'pkg'],
        env: [],
      },
    ]);
  });

  it('resolves a plugin-relative command against the plugin root and keeps header lists separate', async () => {
    const result = await buildCursorMcpServers({
      canopy,
      resolvedMcpServers: {
        bundled: {
          type: 'stdio',
          command: './bin/server',
          cwd: '/plugins/bundled',
        },
      },
      capabilities: { http: true },
      resolveExecutable,
    });
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.servers[2]).toEqual({
      name: 'bundled',
      command: '/plugins/bundled/bin/server',
      args: [],
      env: [],
    });
    const [main, ui] = result.servers;
    expect(main && 'headers' in main && ui && 'headers' in ui).toBe(true);
    if (main && 'headers' in main && ui && 'headers' in ui)
      expect(main.headers).not.toBe(ui.headers);
  });

  it('reports dropped non-string entries and distinguishes relative commands from PATH lookups', async () => {
    const result = await buildCursorMcpServers({
      canopy: null,
      resolvedMcpServers: {
        mixed: {
          type: 'stdio',
          command: '/opt/tools/mcp',
          args: ['--ok', 7],
          env: { A: 'a', B: 2, C: null },
        },
        bundled: { type: 'stdio', command: './missing', cwd: '/plugins/x' },
        bare: { type: 'stdio', command: 'not-installed' },
      },
      capabilities: {},
      resolveExecutable,
    });
    expect(result.servers.map((server) => server.name)).toEqual(['mixed']);
    expect(result.warnings).toEqual([
      'MCP server "mixed" dropped 1 non-string argument and 2 non-string env values.',
      'MCP server "bundled" command "./missing" was not found relative to its own directory and was skipped.',
      'MCP server "bare" command "not-installed" was not found on PATH and was skipped.',
    ]);
  });

  it('skips servers Cursor cannot run and says why', async () => {
    const result = await buildCursorMcpServers({
      canopy,
      resolvedMcpServers: {
        events: { type: 'sse', url: 'https://mcp.example.test/sse' },
        missing: { type: 'stdio', command: 'not-installed' },
        absent: { type: 'stdio', command: '/bin/missing' },
        disabled: { type: 'stdio', command: '/bin/x', enabled: false },
        nested: { type: 'acp', url: 'acp://x' },
        broken: 'not-a-server',
      },
      capabilities: { http: true },
      resolveExecutable,
    });
    expect(result.servers.map((server) => server.name)).toEqual([
      ns,
      `${ns}_ui`,
    ]);
    expect(result.warnings).toEqual([
      'MCP server "events" needs SSE MCP support that Cursor did not advertise and was skipped.',
      'MCP server "missing" command "not-installed" was not found on PATH and was skipped.',
      'MCP server "absent" command "/bin/missing" was not found and was skipped.',
      'MCP server "nested" uses a transport Cursor cannot run and was skipped.',
      'MCP server "broken" has an unrecognized definition and was skipped.',
    ]);
  });
});
