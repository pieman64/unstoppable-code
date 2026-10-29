import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedMcpServers } from './seeders/index.mjs';
import { seedStoredPipeline } from './seeders/seedStoredPipeline.mjs';
import { seedWorkspaceApprovals } from './seeders/seedWorkspaceApprovals.mjs';
import { launchOpenCodeSelectionFixture } from './fixtures/opencode-selection.mjs';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';

for (const { preset, savedDeny = false } of [
  { preset: 'dangerous_all' },
  { preset: 'dangerous_all', savedDeny: true },
  { preset: 'read_only' },
]) {
  test(`OpenCode selected pipeline MCP honors ${preset}${savedDeny ? ' and saved denies' : ''}`, async ({}, testInfo) => {
    test.setTimeout(120_000);
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
          content: [{ type: 'text', text: 'Pipeline MCP executed.' }],
        };
      } else
        result = {
          tools: [
            {
              name: 'files.read',
              inputSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
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
      const name = 'OpenCode selected MCP';
      f = await launchOpenCodeSelectionFixture({
        seedBeforeLaunch: ({ userDataDir }) => {
          const now = new Date().toISOString();
          seedMcpServers({
            userDataDir,
            servers: [
              {
                definition: {
                  id: 'discovery-fixture',
                  name: 'Discovery fixture',
                  description: 'Selected pipeline fixture',
                  type: 'http',
                  url: `http://127.0.0.1:${server.address().port}/mcp`,
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
          mkdirSync(path.join(userDataDir, 'collections'), { recursive: true });
          writeFileSync(
            path.join(
              userDataDir,
              'collections',
              'collection-pipeline-mcp.json',
            ),
            JSON.stringify({
              version: 2,
              collection: {
                id: 'pipeline-mcp',
                name: 'Pipeline MCP',
                skills: [],
                plugins: [],
                mcpServers: [
                  { serverId: 'discovery-fixture', configId: 'default' },
                ],
              },
            }),
          );
          if (savedDeny)
            seedWorkspaceApprovals({
              userDataDir,
              workspaceId: 'demo-ts-pnpm-vite',
              rules: [
                {
                  id: 'deny-mcp',
                  behavior: 'deny',
                  origin: 'settings',
                  createdAt: now,
                  target: {
                    kind: 'mcp',
                    server: 'appproxy-discovery-fixture--d8a1882144e9e422',
                    tool: 'files.read',
                  },
                },
              ],
            });
          writeFileSync(
            path.join(userDataDir, 'pipeline-plugin-preferences.json'),
            JSON.stringify({
              version: 2,
              entries: {
                'stored:user:opencode-selected-mcp': {
                  plugin_collections: {
                    selected: {
                      extraSelections: {
                        collectionIds: ['pipeline-mcp'],
                        pluginRefs: [],
                        skillRefs: [],
                        mcpServerRefs: [
                          {
                            serverId: 'discovery-fixture',
                            configId: 'default',
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
          );
          seedStoredPipeline({
            userDataDir,
            id: 'opencode-selected-mcp',
            name,
            yaml: [
              `name: ${name}`,
              'on: dispatch',
              'plugin_collections:',
              '  - id: selected',
              '    name: Selected MCP',
              '    defaults: []',
              'jobs:',
              '  verify:',
              '    steps:',
              '      - id: opencode',
              '        uses: builtin/agent-prompt',
              '        timeout_minutes: 1',
              '        with:',
              '          model: opencode:fixture%2Fmodel',
              `          permission_preset: ${preset}`,
              '          plugin_collection_id: selected',
              '          prompt: OPENCODE_DOTTED_TOOL',
              '',
            ].join('\n'),
          });
        },
      });
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
      const dir = path.join(f.userDataDir, 'pipeline-executions');
      const entry = readdirSync(dir).find((file) => file.endsWith('.json'));
      const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
      await testInfo.attach('pipeline-execution', {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
      expect(
        state.resolved_plugin_collections.selected.selections.mcpServerRefs,
      ).toHaveLength(1);
      const allowed = preset === 'dangerous_all' && !savedDeny;
      expect(state.jobs.verify.steps.opencode).toMatchObject({
        status: 'success',
        outputs: {
          text_response: allowed
            ? 'Dotted tool allowed.'
            : 'Dotted tool denied.',
        },
      });
      expect(calls).toBe(allowed ? 1 : 0);
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      await f?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
