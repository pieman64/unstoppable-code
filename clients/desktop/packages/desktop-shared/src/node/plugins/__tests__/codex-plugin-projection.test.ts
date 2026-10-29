import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { projectCodexPluginWithoutMcpServers } from '../codex-plugin-projection';

describe('projectCodexPluginWithoutMcpServers', () => {
  it('aborts projection when an MCP reference has a symlinked component', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-projection-'));
    try {
      const source = path.join(root, 'source');
      const external = path.join(root, 'external');
      const victim = path.join(external, 'victim');
      fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, 'sentinel.txt'), 'preserved');
      fs.symlinkSync(
        external,
        path.join(source, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      fs.writeFileSync(
        path.join(source, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: 'unsafe-plugin',
          mcpServers: 'escape/victim',
        }),
      );

      const projectionRoot = path.join(root, 'projection');
      expect(() =>
        projectCodexPluginWithoutMcpServers({
          sourcePluginPath: source,
          marketplaceId: 'marketplace',
          pluginName: 'unsafe-plugin',
          projectionRootDir: projectionRoot,
          warnings: [],
        }),
      ).toThrow('symlinked MCP reference path');

      expect(fs.readFileSync(path.join(victim, 'sentinel.txt'), 'utf8')).toBe(
        'preserved',
      );
      expect(
        fs.existsSync(
          path.join(projectionRoot, 'marketplace', 'unsafe-plugin'),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked source plugin root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-projection-'));
    try {
      const source = path.join(root, 'source');
      const sourceLink = path.join(root, 'source-link');
      fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(source, '.codex-plugin', 'plugin.json'),
        '{"name":"unsafe-plugin"}',
      );
      fs.symlinkSync(
        source,
        sourceLink,
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(() =>
        projectCodexPluginWithoutMcpServers({
          sourcePluginPath: sourceLink,
          marketplaceId: 'marketplace',
          pluginName: 'unsafe-plugin',
          projectionRootDir: path.join(root, 'projection'),
          warnings: [],
        }),
      ).toThrow('symlinked source or manifest path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked source manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-projection-'));
    try {
      const source = path.join(root, 'source');
      const externalManifest = path.join(root, 'plugin.json');
      fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(externalManifest, '{"name":"unsafe-plugin"}');
      fs.symlinkSync(
        externalManifest,
        path.join(source, '.codex-plugin', 'plugin.json'),
        'file',
      );

      expect(() =>
        projectCodexPluginWithoutMcpServers({
          sourcePluginPath: source,
          marketplaceId: 'marketplace',
          pluginName: 'unsafe-plugin',
          projectionRootDir: path.join(root, 'projection'),
          warnings: [],
        }),
      ).toThrow('symlinked source or manifest path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked destination component before deletion', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-projection-'));
    try {
      const source = path.join(root, 'source');
      const projection = path.join(root, 'projection');
      const external = path.join(root, 'external');
      fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
      fs.mkdirSync(projection, { recursive: true });
      fs.mkdirSync(external, { recursive: true });
      fs.writeFileSync(
        path.join(source, '.codex-plugin', 'plugin.json'),
        '{"name":"unsafe-plugin"}',
      );
      fs.writeFileSync(path.join(external, 'sentinel.txt'), 'preserved');
      fs.symlinkSync(
        external,
        path.join(projection, 'marketplace'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      expect(() =>
        projectCodexPluginWithoutMcpServers({
          sourcePluginPath: source,
          marketplaceId: 'marketplace',
          pluginName: 'unsafe-plugin',
          projectionRootDir: projection,
          warnings: [],
        }),
      ).toThrow('symlinked destination path');
      expect(fs.readFileSync(path.join(external, 'sentinel.txt'), 'utf8')).toBe(
        'preserved',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
