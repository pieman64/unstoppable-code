import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedMcpServers, seedWorktreeChat } from './seeders/index.mjs';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';

function seedDiscovery(userDataDir, transport, approvalMode = 'ask') {
  const now = '2026-10-10T00:00:00.000Z';
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'discovery-fixture',
          name: 'Discovery fixture',
          description: 'Selected discovery fixture',
          ...transport,
          createdAt: now,
          updatedAt: now,
        },
        configs: [
          {
            id: 'default',
            name: 'Default',
            description: '',
            enabled: true,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      {
        id: 'opencode-selection',
        title: 'OpenCode integration',
        model: 'sonnet',
        approvalMode,
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [
            { serverId: 'discovery-fixture', configId: 'default' },
          ],
        },
      },
    ],
  });
}

test('OpenCode selected stdio discovery reaches prompting with a non-default host temp directory', async () => {
  const hostTemp = mkdtempSync(path.join(tmpdir(), 'opencode-host-temp-'));
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const input=JSON.parse(line);if(!('id' in input))return;
    const result=input.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'echo',inputSchema:{type:'object'}}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result})+'\\n');
  });`;
  let f;
  try {
    f = await launchOpenCodeSelectionFixture({
      env: { TMPDIR: hostTemp, TMP: hostTemp, TEMP: hostTemp },
      seedBeforeLaunch: ({ userDataDir }) =>
        seedDiscovery(userDataDir, {
          type: 'command',
          command: process.execPath,
          args: ['-e', script],
        }),
    });
    await f.connect();
    await f.select();
    await f.send('Hello after stdio discovery');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    expect((await f.tab()).sdkSessionId).toBeTruthy();
  } finally {
    await f?.close();
    rmSync(hostTemp, { recursive: true, force: true });
  }
});

test('OpenCode rejects oversized selected MCP catalogs before fetching all pages and permits a retry', async ({}, testInfo) => {
  const lifecycleLog = testInfo.outputPath('mcp-retry-lifecycle.jsonl');
  mkdirSync(path.dirname(lifecycleLog), { recursive: true });
  const requests = [];
  let pages = 0;
  let oversized = true;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') return void response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ at: Date.now(), method: input.method, oversized });
    if (!('id' in input)) return void response.writeHead(202).end();
    if (input.method === 'tools/list') pages++;
    const result =
      input.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : {
            tools: [
              {
                // OpenCode lists the server again after the host's discovery,
                // so the valid catalog must keep the same tool name.
                name: oversized ? `tool${pages}` : 'tool',
                description: oversized
                  ? 'x'.repeat(1024 * 1024)
                  : 'valid metadata',
                inputSchema: { type: 'object' },
              },
            ],
            ...(oversized && pages < 10 ? { nextCursor: String(pages) } : {}),
          };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let f;
  try {
    f = await launchOpenCodeSelectionFixture({
      env: { OPENCODE_FIXTURE_LIFECYCLE_LOG: lifecycleLog },
      seedBeforeLaunch: ({ userDataDir }) =>
        seedDiscovery(userDataDir, {
          type: 'http',
          url: `http://127.0.0.1:${server.address().port}/mcp`,
        }),
    });
    await f.connect();
    await f.select();
    await f.send('Check selected catalog');
    await expect(f.panel).toContainText('could not check the tools', {
      timeout: 15000,
    });
    await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(8);
    expect((await f.tab()).sdkSessionId).toBeFalsy();
    oversized = false;
    await f.send('Retry with valid catalog');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible();
  } finally {
    writeFileSync(
      testInfo.outputPath('mcp-retry-requests.json'),
      JSON.stringify({ pages, oversized, requests }, null, 2),
    );
    await f?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// The credential is synthetic and stored only in this fixture's isolated profile.
test('OpenCode discovery does not disclose the app-managed GitHub credential to a selected stdio server', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'opencode-secret-probe-'));
  const receipt = path.join(root, 'environment.json');
  const script = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const input=JSON.parse(line);if(!('id' in input))return;
    if(input.method==='tools/list')require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({managed:process.env.GH_TOKEN==='synthetic-managed-opencode-pat',listed:true}));
    const result=input.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'echo',inputSchema:{type:'object'}}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:input.id,result})+'\\n');
  });`;
  let f;
  try {
    f = await launchOpenCodeSelectionFixture({
      seedBeforeLaunch: ({ userDataDir }) =>
        seedDiscovery(userDataDir, {
          type: 'command',
          command: process.execPath,
          args: ['-e', script],
        }),
    });
    await f.window.evaluate(async () => {
      await window.api.saveGitHubPat('synthetic-managed-opencode-pat');
    });
    expect(
      await f.window.evaluate(
        async () =>
          (await window.api.loadGitHubPat()) ===
          'synthetic-managed-opencode-pat',
      ),
    ).toBe(true);
    await f.connect();
    await f.select();
    await f.send('Check discovery credential isolation');
    await expect(
      f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
      managed: false,
      listed: true,
    });
  } finally {
    await f?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['cancelled', 'deadline']) {
  test(
    'OpenCode stalled HTTP discovery ends after ' +
      mode +
      ' and permits a follow-up',
    async () => {
      let silent = true;
      let opened = 0;
      let closed = 0;
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST')
          return void response.writeHead(405).end();
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (!('id' in input)) return void response.writeHead(202).end();
        const discovery =
          input.method === 'initialize' &&
          input.params?.clientInfo?.name === 'opencode-capability-snapshot';
        if (discovery) opened++;
        response.writeHead(200, { 'content-type': 'application/json' });
        // Auth probing also initializes this endpoint; only stall actual discovery.
        if (silent && discovery) {
          response.once('close', () => {
            closed++;
          });
          response.flushHeaders();
          return;
        }
        const result =
          input.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'silent-fixture', version: '1' },
              }
            : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
        response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      let f;
      try {
        f = await launchOpenCodeSelectionFixture({
          seedBeforeLaunch: ({ userDataDir }) =>
            seedDiscovery(userDataDir, {
              // Provider auth keeps the selected transport direct, so closure is observable.
              type: 'http',
              httpAuthHandler: 'provider',
              url: 'http://127.0.0.1:' + server.address().port + '/mcp',
            }),
        });
        await f.connect();
        await f.select();
        await f.send('Discover the selected silent server');
        await expect.poll(() => opened).toBe(1);
        if (mode === 'cancelled')
          await f.panel.getByTestId('chat-stop-generation').click();
        else
          await expect(f.panel).toContainText('could not check the tools', {
            timeout: 18000,
          });
        await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
        await expect.poll(() => closed).toBe(1);
        expect((await f.tab()).sdkSessionId).toBeFalsy();
        silent = false;
        await f.send('Retry discovery on the responding server');
        await expect(
          f.panel.getByText('OpenCode fixture reply 1.', { exact: true }),
        ).toBeVisible({ timeout: 15000 });
        await expect(f.panel.getByTestId('chat-stop-generation')).toBeHidden();
        expect(opened).toBe(2);
      } finally {
        await f?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
}

for (const annotated of [true, false])
  test(`OpenCode permits approved selected MCP inputs with vendor schema annotations ${annotated ? 'present' : 'absent'}`, async () => {
    let calls = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') return void response.writeHead(405).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (!('id' in input)) return void response.writeHead(202).end();
      let result;
      if (input.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
      else if (input.method === 'tools/call') {
        calls++;
        result = {
          content: [{ type: 'text', text: 'Accepted annotated input.' }],
        };
      } else
        result = {
          tools: [
            {
              name: 'echo',
              inputSchema: {
                type: 'object',
                ...(annotated ? { 'x-vendor': true } : {}),
                properties: {
                  value: {
                    type: 'string',
                    ...(annotated ? { markdownDescription: 'A value' } : {}),
                  },
                },
                required: ['value'],
              },
            },
          ],
        };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let f;
    try {
      f = await launchOpenCodeSelectionFixture({
        approvalMode: 'full-access',
        seedBeforeLaunch: ({ userDataDir }) =>
          seedDiscovery(
            userDataDir,
            {
              type: 'http',
              httpAuthHandler: 'provider',
              url: `http://127.0.0.1:${server.address().port}/mcp`,
            },
            'full-access',
          ),
      });
      await f.connect();
      await f.select();
      await f.send('OPENCODE_ANNOTATED_TOOL');
      await expect(f.panel).toContainText('Annotated tool allowed.');
      expect(calls).toBe(1);
    } finally {
      await f?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

for (const proxied of [true, false])
  for (const collision of [false, true])
    test(`OpenCode matches native MCP names with ${proxied ? 'proxied' : 'direct'} transport and ${collision ? 'colliding' : 'unique'} catalog`, async () => {
      let calls = 0;
      const calledNames = [];
      const server = createServer(async (request, response) => {
        if (request.method !== 'POST')
          return void response.writeHead(405).end();
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (!('id' in input)) return void response.writeHead(202).end();
        let result;
        if (input.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          };
        else if (input.method === 'tools/call') {
          calls++;
          calledNames.push(input.params.name);
          result = {
            content: [{ type: 'text', text: 'Accepted annotated input.' }],
          };
        } else
          result = {
            tools: (collision
              ? ['files.read', 'files_read']
              : ['files.read']
            ).map((name) => ({
              name,
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            })),
          };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      let f;
      try {
        f = await launchOpenCodeSelectionFixture({
          approvalMode: 'full-access',
          seedBeforeLaunch: ({ userDataDir }) =>
            seedDiscovery(
              userDataDir,
              {
                type: 'http',
                ...(proxied ? {} : { httpAuthHandler: 'provider' }),
                url: `http://127.0.0.1:${server.address().port}/mcp`,
              },
              'full-access',
            ),
        });
        await f.connect();
        await f.select();
        await f.send('OPENCODE_DOTTED_TOOL');
        await expect(f.panel).toContainText(
          collision ? 'Dotted tool denied.' : 'Dotted tool allowed.',
        );
        expect(calls).toBe(collision ? 0 : 1);
        expect(calledNames).toEqual(collision ? [] : ['files.read']);
      } finally {
        await f?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
