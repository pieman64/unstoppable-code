import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectClaudePluginWithoutMcpServers } from '../plugins/claude-plugin-projection';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writePluginFixture(sourcePluginPath: string): void {
  const manifestDir = path.join(sourcePluginPath, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify(
      {
        name: 'Example Plugin',
        mcpServers: ['.mcp.json'],
      },
      null,
      2,
    ),
    'utf8',
  );
  fs.writeFileSync(path.join(sourcePluginPath, '.mcp.json'), '{}', 'utf8');
}

afterEach((): void => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('normalizes dot segments so projected plugin paths stay inside the root', () => {
  const sourcePluginPath = createTempDir('canopy-plugin-source-');
  const projectionRootDir = createTempDir('canopy-plugin-projection-');
  writePluginFixture(sourcePluginPath);

  const warnings: string[] = [];
  const projectedPluginPath = projectClaudePluginWithoutMcpServers({
    sourcePluginPath,
    marketplaceId: '..',
    pluginName: '.',
    projectionRootDir,
    warnings,
  });

  expect(warnings).toEqual([]);
  expect(projectedPluginPath).toBe(
    path.join(projectionRootDir, 'plugin', 'plugin'),
  );
  expect(
    path.relative(projectionRootDir, projectedPluginPath).startsWith('..'),
  ).toBe(false);
  expect(
    fs.existsSync(
      path.join(projectedPluginPath, '.claude-plugin', 'plugin.json'),
    ),
  ).toBe(true);
  expect(fs.existsSync(path.join(projectedPluginPath, '.mcp.json'))).toBe(
    false,
  );
});
