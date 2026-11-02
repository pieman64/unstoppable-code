import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, readFileSync } from 'node:fs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import {
  seedPluginConnectionDesign,
  installPluginConnectionDesignHandlers,
} from './pluginConnectionDesignFixture.mjs';

export const skillDescription =
  'Build AI agents and knowledge bases for Falcon Foundry apps. TRIGGER when user asks to "create an AI agent", "build an agent", "add a Foundry agent", "add a knowledge base", "give my agent documents", "expose a collection as an agent tool", "expose an API operation to an agent", "put my agent in Charlotte", "expose an agent as a tool for other agents", "delete an agent or knowledge base", runs foundry agents create, foundry agents delete, foundry knowledge-bases create, or foundry knowledge-bases delete, or needs help with agent system prompts and input/output formats. DO NOT TRIGGER for Fusion SOAR workflow YAML — use workflows-development. DO NOT TRIGGER for serverless function handlers — use functions-development.';

export async function openCalmPluginDetail({ recordVideoDir } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'plugin-detail-calm-'),
  );
  seedPluginConnectionDesign(userDataDir);
  const cacheFile = path.join(userDataDir, 'plugins-cache.json');
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  const plugin = cache.marketplaces[0].plugins.find(
    (entry) => entry.name === 'gmail',
  );
  const details = {
    skills: [
      {
        name: 'ai-agents-development',
        path: 'skills/ai-agents-development',
        description: skillDescription,
      },
      {
        name: 'api-integrations',
        path: 'skills/api-integrations',
        description:
          'Expose external APIs to Falcon Foundry via OpenAPI specifications.',
      },
      {
        name: 'workflows-development',
        path: 'skills/workflows-development',
        description: 'Build and manage Fusion SOAR workflows.',
      },
    ],
    agents: [],
    commands: [],
    apps: [],
    hooks: [],
    lspServers: [],
    mcpServers: [],
    hasReadme: true,
  };
  const facet = {
    provider: 'claude',
    mode: 'native',
    name: 'gmail',
    displayName: 'CrowdStrike Falcon Foundry',
    installLocation: '/tmp/demo-market',
    sourcePath: 'plugins/gmail',
    details,
  };
  Object.assign(plugin, {
    displayName: 'CrowdStrike Falcon Foundry',
    version: '1.5.0',
    author: 'CrowdStrike',
    category: 'security',
    description:
      'CrowdStrike Falcon Foundry development skills for building cybersecurity applications on the Falcon platform. Includes UI development, collections, functions, workflows, API integration, security patterns, and debugging workflows. Swagger 2.0 specs are auto-converted to OpenAPI 3.0 via npx swagger2openapi (requires Node.js; network call to npm registry).',
    homepage: 'https://github.com/CrowdStrike/foundry-skills',
    externalSource: 'https://github.com/CrowdStrike/foundry-skills.git',
    cachedAt: '2026-09-22T12:00:00Z',
    providerSupport: { claude: 'native', codex: 'compat' },
    facets: {
      claude: facet,
      codexCompatibility: { ...facet, provider: 'codex', mode: 'compat' },
    },
    details,
    globalInstallStatus: {
      claude: { available: true, installed: true },
      codex: { available: true, installed: true },
    },
  });
  writeJson(cacheFile, cache);
  const { electronApp } = await launchCanopy({ userDataDir, recordVideoDir });
  await installPluginConnectionDesignHandlers(electronApp);
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('mcp-servers:list-detected');
    ipcMain.handle('mcp-servers:list-detected', () => ({
      warnings: [],
      servers: [],
    }));
    ipcMain.removeHandler('plugins:read-component');
    ipcMain.handle('plugins:read-component', () => ({
      success: true,
      data: {
        frontmatter: {},
        body: 'Full agent development instructions remain available.',
      },
    }));
  });
  const window = await electronApp.firstWindow();
  await window.reload();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openPluginsPage();
  await window.getByTestId('plugins-search').fill('CrowdStrike');
  await window.getByTestId('customize-row-mkt:demo/market/gmail').click();
  return { electronApp, window, userDataDir };
}
