import { normalizePluginFiles, resolvePluginPath } from './file-map';
import type {
  PluginFileContent,
  ProjectCodexPluginWithoutMcpServersInput,
} from './types';

function removePath(
  files: Map<string, PluginFileContent>,
  target: string,
): void {
  for (const filePath of Array.from(files.keys())) {
    if (filePath === target || filePath.startsWith(`${target}/`)) {
      files.delete(filePath);
    }
  }
}

export function projectCodexPluginWithoutMcpServers(
  input: ProjectCodexPluginWithoutMcpServersInput,
): ReadonlyMap<string, PluginFileContent> {
  const files = normalizePluginFiles(input.files);
  const configured = input.manifest.mcpServers;
  const references: string[] = [];
  if (typeof configured === 'string') {
    references.push(configured);
  } else if (Array.isArray(configured)) {
    for (const entry of configured) {
      if (typeof entry === 'string') references.push(entry);
    }
  }
  for (const reference of references) {
    const resolved = resolvePluginPath(reference);
    if (resolved !== null && resolved.length > 0) removePath(files, resolved);
  }
  files.delete('.mcp.json');
  const manifest: Record<string, unknown> = { ...input.manifest };
  delete manifest.mcpServers;
  files.set(
    '.codex-plugin/plugin.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return files;
}
