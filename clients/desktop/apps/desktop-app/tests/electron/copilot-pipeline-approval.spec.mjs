import { createServer } from 'node:http';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { openWorkspaceAndRun } from './codexPipelineRuntime.mjs';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import {
  seedStoredPipeline,
  seedPluginsCache,
  seedMcpServers,
  seedDeferredEchoServer,
  seedWorkspaceApprovals,
  buildApprovalRule,
} from './seeders/index.mjs';

for (const { denied, changeSchema } of [
  { denied: false, changeSchema: false },
  { denied: true, changeSchema: false },
  { denied: false, changeSchema: true },
]) {
  test(`Copilot pipeline MCP ${changeSchema ? 'rejects a changed native schema on resume' : denied ? 'honors a saved deny' : 'runs a selected tool'} without prompting`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const f = await launchCopilotSelectionFixture();
    let upstream;
    let schemaVersion = 1;
    let toolCalls = 0;
    try {
      const { logPath } = seedDeferredEchoServer(f.userDataDir);
      upstream = createServer(async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(404).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result;
        if (message.method === 'initialize')
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'pipeline-echo', version: '1' },
          };
        else if (message.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'deferred_echo',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    ...(schemaVersion === 1
                      ? {}
                      : { newFlag: { type: 'boolean' } }),
                  },
                  required: ['message'],
                },
              },
            ],
          };
        else if (message.method === 'tools/call') {
          toolCalls++;
          if (changeSchema) schemaVersion = 2;
          writeFileSync(logPath, message.params.arguments.message);
          result = { content: [{ type: 'text', text: 'echo complete' }] };
        } else result = {};
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      });
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const server = JSON.parse(
        readFileSync(
          path.join(f.userDataDir, 'mcp-servers', 'server-dr.json'),
          'utf8',
        ),
      ).server;
      delete server.definition.command;
      delete server.definition.args;
      Object.assign(server.definition, {
        type: 'http',
        url: `http://127.0.0.1:${upstream.address().port}/mcp`,
        httpAuthHandler: 'canopy',
      });
      seedMcpServers({ userDataDir: f.userDataDir, servers: [server] });
      const name = 'Copilot pipeline MCP approval';
      mkdirSync(path.join(f.userDataDir, 'collections'), { recursive: true });
      writeFileSync(
        path.join(f.userDataDir, 'collections', 'collection-pipeline-mcp.json'),
        JSON.stringify({
          version: 2,
          collection: {
            id: 'pipeline-mcp',
            name: 'Pipeline MCP',
            skills: [],
            plugins: [],
            mcpServers: [{ serverId: 'dr', configId: 'd' }],
          },
        }),
      );
      seedWorkspaceApprovals({
        userDataDir: f.userDataDir,
        workspaceId: f.target.projectId,
        rules: denied
          ? [
              buildApprovalRule({
                behavior: 'deny',
                target: {
                  kind: 'mcp',
                  // Identity of the HTTP proxy (kind=proxy, ids dr/d).
                  server: 'appproxy-deferred-reload-fixtu--5b323b005caeb121',
                  tool: 'deferred_echo',
                },
              }),
            ]
          : [],
      });
      writeFileSync(
        path.join(f.userDataDir, 'pipeline-plugin-preferences.json'),
        JSON.stringify({
          version: 2,
          entries: {
            'stored:user:copilot-mcp-policy': {
              plugin_collections: {
                selected: {
                  extraSelections: {
                    collectionIds: ['pipeline-mcp'],
                    pluginRefs: [],
                    skillRefs: [],
                    mcpServerRefs: [],
                  },
                },
              },
            },
          },
        }),
      );
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id: 'copilot-mcp-policy',
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
          '      - id: copilot',
          '        uses: builtin/agent-prompt',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          '          permission_preset: dangerous_all',
          '          plugin_collection_id: selected',
          '          prompt: COPILOT_PIPELINE_MCP',
          ...(changeSchema
            ? [
                '      - id: resumed',
                '        uses: builtin/agent-resume',
                '        timeout_minutes: 1',
                '        with:',
                '          session_id: ${{ steps.copilot.outputs.session_id }}',
                '          model: copilot:fixture-model',
                '          permission_preset: dangerous_all',
                '          plugin_collection_id: selected',
                '          prompt: COPILOT_PIPELINE_MCP',
              ]
            : []),
          '',
        ].join('\n'),
      });
      await f.restart();
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
      const dir = path.join(f.userDataDir, 'pipeline-executions');
      const entry = readdirSync(dir).find((name) => name.endsWith('.json'));
      const state = JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
      await testInfo.attach('pipeline-execution', {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
      expect(
        state.jobs.verify.steps.copilot,
        JSON.stringify(state.jobs.verify.steps.copilot),
      ).toMatchObject({ status: denied ? 'failure' : 'success' });
      if (changeSchema) {
        expect(state.jobs.verify.steps.resumed).toMatchObject({
          status: 'failure',
        });
        expect(state.jobs.verify.steps.resumed.error).toMatch(
          /capabilit|configuration|tool.*changed/i,
        );
        expect(toolCalls).toBe(1);
      }
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
      if (denied) {
        expect(existsSync(logPath)).toBe(false);
        expect(state.jobs.verify.steps.copilot.error).toContain(
          'App MCP call denied',
        );
      } else {
        expect(readFileSync(logPath, 'utf8')).toContain(
          'copilot-pipeline-approval-sentinel',
        );
      }
    } finally {
      await f.close();
      if (upstream) {
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
      }
    }
  });
}

for (const [initialEnabled, resumedEnabled] of [
  [true, false],
  [false, true],
  [true, true],
]) {
  test(`Copilot pipeline resume after MCP enabled changes ${initialEnabled} to ${resumedEnabled}`, async ({}, testInfo) => {
    test.setTimeout(120_000);
    const f = await launchCopilotSelectionFixture();
    try {
      const marketplaceDir = path.join(f.userDataDir, 'fixture-marketplace');
      const pluginDir = path.join(marketplaceDir, 'plugins', 'delta-tool');
      mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
      writeFileSync(
        path.join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'delta-tool',
          version: '1.0.0',
          mcpServers: './.mcp.json',
        }),
      );
      const mcpFile = path.join(pluginDir, '.mcp.json');
      const { logPath } = seedDeferredEchoServer(f.userDataDir);
      const scriptPath = path.join(
        path.dirname(logPath),
        'deferred-echo-mcp.cjs',
      );
      const definition = {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        env: { DEFERRED_RELOAD_MCP_LOG: logPath },
        enabled: initialEnabled,
      };
      writeFileSync(
        mcpFile,
        JSON.stringify({ mcpServers: { selected: definition } }),
      );
      const { cacheFilePath } = seedPluginsCache({
        userDataDir: f.userDataDir,
      });
      const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
      cache.marketplaces[0].installLocation = marketplaceDir;
      const plugin = cache.marketplaces[0].plugins.find(
        (entry) => entry.name === 'delta-tool',
      );
      plugin.facets.claude = {
        provider: 'claude',
        mode: 'native',
        name: 'delta-tool',
        sourcePath: plugin.sourcePath,
        details: plugin.details,
      };
      writeFileSync(cacheFilePath, JSON.stringify(cache));
      const id = 'copilot-mcp-resume';
      const name = 'Copilot MCP resume binding';
      writeFileSync(
        path.join(f.userDataDir, 'pipeline-plugin-preferences.json'),
        JSON.stringify({
          version: 2,
          entries: {
            [`stored:user:${id}`]: {
              plugin_collections: {
                selected: {
                  extraSelections: {
                    collectionIds: [],
                    skillRefs: [],
                    pluginRefs: [
                      {
                        marketplaceId: 'demo/market',
                        pluginName: 'delta-tool',
                      },
                    ],
                  },
                },
              },
            },
          },
        }),
      );
      // A normal pipeline step changes the installed plugin between turns.
      const editScript = path.join(f.worktreePath, 'change-selected-mcp.cjs');
      writeFileSync(
        editScript,
        `const fs = require('node:fs'); const file = ${JSON.stringify(mcpFile)}; const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.mcpServers.selected.enabled = ${resumedEnabled}; fs.writeFileSync(file, JSON.stringify(data));`,
      );
      const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
      seedStoredPipeline({
        userDataDir: f.userDataDir,
        id,
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
          '      - id: initial',
          '        uses: builtin/agent-prompt',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          '          permission_preset: read_only',
          '          plugin_collection_id: selected',
          '          prompt: Hello Copilot',
          '      - id: change',
          `        run: ${JSON.stringify(`${quote(process.execPath)} ${quote(editScript)}`)}`,
          '      - id: resumed',
          '        uses: builtin/agent-resume',
          '        timeout_minutes: 1',
          '        with:',
          '          model: copilot:fixture-model',
          '          session_id: ${{ steps.initial.outputs.session_id }}',
          '          permission_preset: read_only',
          '          plugin_collection_id: selected',
          '          prompt: Continue Copilot',
          '',
        ].join('\n'),
      });
      await f.restart();
      await f.connect();
      const card = await openWorkspaceAndRun(f.window, name);
      await expect(card).toContainText(/success|failure/, { timeout: 60_000 });
      const dir = path.join(f.userDataDir, 'pipeline-executions');
      const entry = readdirSync(dir).find((file) => file.endsWith('.json'));
      const readState = () =>
        JSON.parse(readFileSync(path.join(dir, entry), 'utf8'));
      await expect
        .poll(() => readState().status, { timeout: 60_000 })
        .toMatch(/^(success|failure)$/);
      const state = readState();
      await testInfo.attach('pipeline-execution', {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
      expect(state.jobs.verify.steps.initial.status).toBe('success');
      expect(state.jobs.verify.steps.change.status).toBe('success');
      expect(
        JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers.selected.enabled,
      ).toBe(resumedEnabled);
      const changed = initialEnabled !== resumedEnabled;
      expect(state.jobs.verify.steps.resumed.status).toBe(
        changed ? 'failure' : 'success',
      );
      if (changed)
        expect(JSON.stringify(state.jobs.verify.steps.resumed)).toMatch(
          /capabilit|configuration/i,
        );
      await expect(f.window.getByTestId('tool-approval-card')).toHaveCount(0);
    } finally {
      await f.close();
    }
  });
}
