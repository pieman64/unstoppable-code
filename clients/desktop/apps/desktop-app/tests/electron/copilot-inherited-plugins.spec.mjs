import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { launchCopilotSelectionFixture } from './fixtures/copilot-selection.mjs';
import { seedDeferredEchoServer } from './seeders/index.mjs';
import { chooseSettingsOption } from './helpers/settingsSelect.mjs';

for (const scenario of [
  'inherit',
  'opt-out',
  'selector-drift',
  'home-only-budget',
]) {
  const inherit = scenario !== 'opt-out';
  const tamper = scenario === 'selector-drift';
  const budget = scenario === 'home-only-budget';
  const marketplaceId = budget ? 'm'.repeat(250) : 'fixture-market';
  const pluginName = budget ? 'p'.repeat(190) : 'home-tool';
  test(`Copilot child ${budget ? 'skips oversized home-only metadata while retaining home skills' : tamper ? 'rejects an inherited credential selector change' : inherit ? 'uses its parent installed plugin' : 'honors installed plugin opt-out'}`, async () => {
    test.setTimeout(180_000);
    let logPath;
    let configFile;
    const authorizations = [];
    const upstream =
      tamper || budget
        ? createServer(async (request, response) => {
            if (request.method !== 'POST') {
              response.writeHead(405).end();
              return;
            }
            let body = '';
            for await (const chunk of request) body += chunk;
            const message = JSON.parse(body);
            authorizations.push(request.headers.authorization);
            if (message.id === undefined) {
              response.writeHead(202).end();
              return;
            }
            const result =
              message.method === 'initialize'
                ? {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'selector-fixture', version: '1' },
                  }
                : message.method === 'tools/list'
                  ? {
                      tools: [
                        {
                          name: 'deferred_echo',
                          description: 'Echo fixture evidence',
                          inputSchema: {
                            type: 'object',
                            properties: { message: { type: 'string' } },
                          },
                        },
                      ],
                    }
                  : {
                      content: [
                        { type: 'text', text: 'installed plugin child' },
                      ],
                    };
            response
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
          })
        : null;
    if (upstream)
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream?.address();
    const upstreamUrl =
      upstreamAddress && typeof upstreamAddress === 'object'
        ? `http://127.0.0.1:${upstreamAddress.port}/mcp`
        : undefined;
    const f = await launchCopilotSelectionFixture({
      approvalMode: 'full-access',
      seedBeforeLaunch: ({ userDataDir }) => {
        logPath = seedDeferredEchoServer(userDataDir).logPath;
        const claude = path.join(userDataDir, 'provider-state', 'claude');
        const installed = path.join(
          claude,
          'plugins',
          'cache',
          marketplaceId,
          pluginName,
          '1.0.0',
        );
        const checkout = path.join(
          userDataDir,
          'marketplace-fixture',
          pluginName,
        );
        for (const [dir, sentinel] of [
          [installed, 'COPILOT_INSTALLED_PLUGIN_CANARY'],
          [checkout, 'WRONG_MARKETPLACE_VERSION'],
        ]) {
          mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
          mkdirSync(path.join(dir, 'skills', 'review'), { recursive: true });
          writeFileSync(
            path.join(dir, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: pluginName }),
          );
          if (!budget)
            writeFileSync(
              path.join(dir, 'skills', 'review', 'SKILL.md'),
              `---\nname: review\ndescription: Installed plugin review\n---\n${sentinel}\n`,
            );
        }
        if (budget) {
          const skill = path.join(claude, 'skills', 'home-delegate');
          mkdirSync(skill, { recursive: true });
          writeFileSync(
            path.join(skill, 'SKILL.md'),
            '---\nname: home-delegate\ndescription: Retained home review\n---\nCOPILOT_HOME_DELEGATE_CANARY\n',
          );
          for (let index = 0; index < 15; index += 1)
            writeFileSync(
              path.join(skill, `guidance-${index}.md`),
              'Guidance. '.repeat(5800),
            );
        }
        configFile = path.join(installed, '.mcp.json');
        writeFileSync(
          configFile,
          JSON.stringify({
            mcpServers: budget
              ? Object.fromEntries(
                  Array.from({ length: 128 }, (_, index) => [
                    's'.repeat(245) + index,
                    { type: 'http', url: upstreamUrl },
                  ]),
                )
              : {
                  review: tamper
                    ? {
                        type: 'http',
                        url: upstreamUrl,
                        env_http_headers: {
                          Authorization: 'COPILOT_PIN_SCOPED_TOKEN',
                        },
                      }
                    : {
                        type: 'stdio',
                        command: process.execPath,
                        args: [
                          path.join(
                            userDataDir,
                            'mcp-fixtures',
                            'deferred-echo-mcp.cjs',
                          ),
                        ],
                        env: { DEFERRED_RELOAD_MCP_LOG: logPath },
                      },
                },
          }),
        );
        writeFileSync(
          path.join(claude, 'plugins', 'installed_plugins.json'),
          JSON.stringify({
            version: 2,
            plugins: {
              [`${pluginName}@${marketplaceId}`]: [
                { scope: 'user', installPath: installed, version: '1.0.0' },
              ],
            },
          }),
        );
        const now = new Date().toISOString();
        const status = (provider, state, accepted, pluginCount) => ({
          provider,
          state,
          accepted,
          pluginCount,
          lastCheckedAt: now,
        });
        writeFileSync(
          path.join(userDataDir, 'plugins-cache.json'),
          JSON.stringify({
            version: 2,
            lastRefreshed: now,
            lastProviderRefreshAt: now,
            marketplaces: [
              {
                id: marketplaceId,
                name: marketplaceId,
                description: 'Fixture',
                sourceType: 'local',
                sourceUrl: '',
                installLocation: path.dirname(checkout),
                pluginCount: 1,
                validProviders: ['claude'],
                providerStatus: {
                  claude: status('claude', 'valid', true, 1),
                  codex: status('codex', 'invalid', false, 0),
                },
                plugins: [
                  {
                    name: pluginName,
                    marketplaceId,
                    description: 'Fixture plugin',
                    sourcePath: checkout,
                    providerSupport: { claude: 'native', codex: 'none' },
                    facets: {
                      claude: {
                        provider: 'claude',
                        mode: 'native',
                        name: pluginName,
                        installLocation: checkout,
                        sourcePath: checkout,
                      },
                    },
                  },
                ],
              },
            ],
          }),
        );
      },
    });
    try {
      if (tamper)
        await f.app.evaluate(() => {
          process.env.COPILOT_PIN_SCOPED_TOKEN = 'scoped-fixture-value';
          process.env.COPILOT_PIN_PRIVATE_SECRET = 'private-fixture-value';
        });
      await f.connect();
      await f.driver.openSettings();
      await f.driver.openSettingsSection('experiments');
      await chooseSettingsOption(
        f.window.getByTestId('settings-managed-delegation-mode'),
        'explicit-only',
      );
      await f.driver.closeSettings();
      await f.select();
      await f.send(
        `${budget ? 'COPILOT_HOME_PARENT' : 'COPILOT_PLUGIN_HOME_PARENT'}${inherit ? '' : ' HOME_OPT_OUT'}${tamper ? ' MCP_SELECTOR_DRIFT MCP_SELECTOR_FILE=' + encodeURIComponent(configFile) : ''}: delegate using the installed plugin.`,
      );
      if (budget) {
        await expect(
          f.panel.getByText(
            /Integrated Copilot child:.*COPILOT_HOME_DELEGATE_CANARY retained and readable/,
          ),
        ).toBeVisible({ timeout: 90_000 });
        const collapsedSteps = f.panel.getByRole('button', {
          name: /^Agent steps:/,
          expanded: false,
        });
        if (await collapsedSteps.count()) await collapsedSteps.first().click();
        const card = f.panel.getByTestId('chat-delegated-agent').first();
        await expect(card).toBeVisible();
        await card
          .getByRole('button', { name: 'Expand delegated task' })
          .click();
        await card.getByTestId('delegated-agent-capabilities-toggle').click();
        await expect(
          card.getByTestId('delegated-agent-capability-skipped'),
        ).toContainText(pluginName);
        return;
      }
      if (tamper) {
        await expect(
          f.panel.getByText(
            /Error: Delegate launch failed|Integrated Copilot child:.*"currentStatus":"failed"/,
          ),
        ).toBeVisible({ timeout: 90_000 });
        expect(authorizations).toContain('scoped-fixture-value');
        expect(authorizations).not.toContain('private-fixture-value');
        return;
      }
      await expect(
        f.panel.getByTestId('chat-delegated-agent').first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        f.panel.getByText(
          inherit
            ? /Integrated Copilot child:.*Installed plugin content and MCP retained/
            : /Integrated Copilot child:.*Installed plugin inheritance is disabled/,
        ),
      ).toBeVisible({ timeout: 90_000 });
      expect(
        logPath && existsSync(logPath)
          ? readFileSync(logPath, 'utf8').trim().split('\n')
          : [],
      ).toEqual(inherit ? ['called: installed plugin child'] : []);
    } finally {
      await f.close();
      if (upstream) {
        upstream.closeAllConnections();
        await new Promise((resolve) => upstream.close(resolve));
      }
    }
  });
}
