import { readFileSync, writeFileSync } from 'node:fs';
import { seedMcpServers } from './seedMcpServers.mjs';
import { seedPluginsCache } from './seedPluginsCache.mjs';

/** Catalog metadata plus the real bundled app mark; no live image requests. */
export function seedPluginActivityLogos(userDataDir) {
  const { cacheFilePath } = seedPluginsCache({ userDataDir });
  const cache = JSON.parse(readFileSync(cacheFilePath, 'utf8'));
  for (const plugin of cache.marketplaces[0].plugins) {
    if (plugin.name === 'delta-tool') {
      plugin.logoUrl = 'https://logos.invalid/app.png';
      plugin.displayName = 'Delta Tools';
    }
    if (plugin.name === 'gamma-tool')
      plugin.logoUrl = 'https://logos.invalid/broken.png';
  }
  writeFileSync(cacheFilePath, JSON.stringify(cache));
  seedMcpServers({
    userDataDir,
    servers: [
      {
        definition: {
          id: 'curated-slack',
          name: 'Slack',
          type: 'http',
          url: 'https://mcp.invalid/slack',
          curated: { key: 'slack', logoUrl: 'https://logos.invalid/app.png' },
        },
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      },
      {
        definition: {
          id: 'curated-figma',
          name: 'Figma',
          type: 'http',
          url: 'https://mcp.invalid/figma',
          curated: {
            key: 'figma',
            logoUrl: 'https://logos.invalid/broken.png',
          },
        },
        configs: [{ id: 'default', name: 'Default', enabled: true }],
      },
    ],
  });
}

export async function stubPluginActivityLogoResolution(electronApp) {
  const png = readFileSync(
    new URL('../../../../../brands/canopy/icons/32x32.png', import.meta.url),
  ).toString('base64');
  await electronApp.evaluate(({ ipcMain }, image) => {
    ipcMain.removeHandler('mcp-servers:resolve-remote-image');
    ipcMain.handle('mcp-servers:resolve-remote-image', (_event, url) =>
      url === 'https://logos.invalid/app.png'
        ? `data:image/png;base64,${image}`
        : 'data:image/png;base64,AAAA',
    );
  }, png);
}
