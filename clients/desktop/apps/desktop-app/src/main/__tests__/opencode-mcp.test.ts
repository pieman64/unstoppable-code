import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getEnhancedEnv: jest.fn(() => ({
    PATH: '/fixture/host-bin',
    HOME: '/fixture/home',
    HOST_SECRET: 'not-selected',
  })),
  getBundledBinaryMember: (command: string): string | undefined =>
    ['gh', 'rg'].find((member) => command === member),
  resolveBundledBinary: (member: string): { path: string } => ({
    path: `/fixture/bundled/${member}`,
  }),
}));
import {
  buildOpenCodeMcpServers,
  resolveOpenCodeMcpCall,
} from '../opencode/mcp-servers';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';

test('preserves selected stdio arguments, environment and cwd without a shell', () => {
  const servers = buildOpenCodeMcpServers({
    cwd: '/workspace',
    definitions: {
      selected: {
        command: 'node',
        args: ['a file.js', '$(literal)'],
        cwd: '/plugin',
        env: { TOKEN: 'fixture' },
      },
    },
  });
  expect(servers).toHaveLength(1);
  const server = servers[0];
  if (!('command' in server)) throw new Error('Expected stdio');
  expect(server.command).toBe(process.execPath);
  expect(server).toHaveProperty(
    'args',
    expect.arrayContaining([
      JSON.stringify({
        command: 'node',
        args: ['a file.js', '$(literal)'],
        cwd: '/plugin',
      }),
    ]),
  );
  expect(server).toHaveProperty(
    'env',
    expect.arrayContaining([
      { name: 'TOKEN', value: 'fixture' },
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    ]),
  );
});

test('unsupported filters and ambiguous MCP identities fail closed', () => {
  expect(() =>
    buildOpenCodeMcpServers({
      cwd: '/',
      definitions: {
        selected: {
          type: 'http',
          url: 'https://example.test/mcp',
          allowedTools: ['read'],
        },
      },
    }),
  ).toThrow('tool filters');
  const servers = buildOpenCodeMcpServers({
    cwd: '/',
    definitions: { a: { command: 'a' }, a_b: { command: 'b' } },
  });
  expect(
    resolveOpenCodeMcpCall('a_b_read', servers, 'default'),
  ).toBeUndefined();
  expect(resolveOpenCodeMcpCall('a_read', servers, 'default')).toEqual({
    server: 'a',
    tool: 'read',
    http: false,
  });
});

test('only advertised app and managed tools resolve to the private route', () => {
  const servers = buildOpenCodeMcpServers({
    cwd: '/',
    definitions: {},
    mainUrl: 'http://127.0.0.1/main',
    uiUrl: 'http://127.0.0.1/ui',
    authToken: 'fixture',
  });
  const names = cursorCanopyMcpServerNames('default');
  expect(
    resolveOpenCodeMcpCall(`${names.main}_SpawnDelegate`, servers, 'default', [
      'SpawnDelegate',
    ]),
  ).toEqual({ server: names.main, tool: 'SpawnDelegate', http: true });
  expect(
    resolveOpenCodeMcpCall(`${names.main}_Unadvertised`, servers, 'default'),
  ).toBeUndefined();
});

test.each([undefined, '/plugin'])(
  'selected stdio servers receive the host launch environment and bundled binaries (cwd %s)',
  (cwd) => {
    const servers = buildOpenCodeMcpServers({
      cwd: '/workspace',
      definitions: {
        selected: {
          command: 'gh',
          args: ['literal argument'],
          ...(cwd ? { cwd } : {}),
          env: { TOKEN: 'fixture' },
        },
      },
    });
    expect(getEnhancedEnv).toHaveBeenCalled();
    const server = servers[0];
    if (!('command' in server)) throw new Error('Expected stdio');
    expect(server.env).toEqual(
      expect.arrayContaining([
        { name: 'PATH', value: '/fixture/host-bin' },
        { name: 'TOKEN', value: 'fixture' },
      ]),
    );
    if (cwd)
      expect(server.args).toContain(
        JSON.stringify({
          command: '/fixture/bundled/gh',
          args: ['literal argument'],
          cwd,
        }),
      );
    else expect(server.command).toBe('/fixture/bundled/gh');
  },
);

test('cwd launcher executes with the host PATH and keeps arguments literal', async () => {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), 'opencode-mcp-launch-')),
  );
  try {
    const [server] = buildOpenCodeMcpServers({
      cwd: '/workspace',
      definitions: {
        fixture: {
          command: process.execPath,
          cwd,
          args: [
            '-e',
            'process.stdout.write(JSON.stringify({cwd:process.cwd(),path:process.env.PATH,arg:process.argv[1]}))',
            '$(literal)',
          ],
          env: { TOKEN: 'fixture' },
        },
      },
    });
    if (!('command' in server)) throw new Error('Expected stdio');
    const { stdout } = await promisify(execFile)(server.command, server.args, {
      env: Object.fromEntries(
        server.env.map(({ name, value }) => [name, value]),
      ),
    });
    expect(JSON.parse(stdout)).toEqual({
      cwd,
      path: '/fixture/host-bin',
      arg: '$(literal)',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('launch setup does not forward unrelated host credentials into a restricted provider', () => {
  const [server] = buildOpenCodeMcpServers({
    cwd: '/workspace',
    definitions: {
      selected: { command: 'node', env: { TOKEN: 'selected-credential' } },
    },
  });
  if (!('command' in server)) throw new Error('Expected stdio');
  expect(server.env.some(({ name }) => name === 'HOST_SECRET')).toBe(false);
  expect(server.env).toContainEqual({
    name: 'TOKEN',
    value: 'selected-credential',
  });
});

for (const raw of ['files.read', 'files/read', 'files:read'])
  test(`native MCP key resolves to its unique raw catalog identity: ${raw}`, () => {
    const servers = buildOpenCodeMcpServers({
      cwd: '/',
      definitions: {
        selected: { type: 'http', url: 'https://example.test/mcp' },
      },
    });
    const snapshot = [
      {
        name: 'selected',
        identity: {},
        tools: [{ name: raw, inputSchema: { type: 'object' as const } }],
      },
    ];
    expect(
      resolveOpenCodeMcpCall(
        'selected_files_read',
        servers,
        'default',
        [],
        snapshot,
      ),
    ).toEqual({ server: 'selected', tool: raw, http: true });
  });

test('native MCP keys deny colliding tool aliases, including raw names that are already safe', () => {
  const servers = buildOpenCodeMcpServers({
    cwd: '/',
    definitions: { selected: { command: 'fixture' } },
  });
  const snapshot = [
    {
      name: 'selected',
      identity: {},
      tools: ['files.read', 'files_read'].map((name) => ({
        name,
        inputSchema: { type: 'object' as const },
      })),
    },
  ];
  expect(
    resolveOpenCodeMcpCall(
      'selected_files_read',
      servers,
      'default',
      [],
      snapshot,
    ),
  ).toBeUndefined();
});

test('a captured catalog cannot grant an unadvertised private app tool', () => {
  const servers = buildOpenCodeMcpServers({
    cwd: '/',
    definitions: {},
    mainUrl: 'http://127.0.0.1/main',
    uiUrl: 'http://127.0.0.1/ui',
    authToken: 'fixture',
  });
  const names = cursorCanopyMcpServerNames('default');
  const snapshot = [
    {
      name: names.main,
      identity: {},
      tools: [
        { name: 'Unadvertised', inputSchema: { type: 'object' as const } },
      ],
    },
  ];
  expect(
    resolveOpenCodeMcpCall(
      `${names.main}_Unadvertised`,
      servers,
      'default',
      [],
      snapshot,
    ),
  ).toBeUndefined();
  expect(
    resolveOpenCodeMcpCall(
      `${names.main}_Unknown`,
      servers,
      'default',
      [],
      snapshot,
    ),
  ).toBeUndefined();
});
