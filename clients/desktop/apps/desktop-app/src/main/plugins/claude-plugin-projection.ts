import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeReadJson } from '../lib/fs-utils';
import { isPathInside } from '../lib/path-safety';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0 || normalized === '.' || normalized === '..') {
    return 'plugin';
  }
  return normalized;
}

function removePath(targetPath: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function removeReferencedMcpFiles(
  sourcePluginPath: string,
  projectedPluginPath: string,
  rawManifest: Record<string, unknown>,
): void {
  const manifestValue = rawManifest.mcpServers;
  const relativePaths =
    typeof manifestValue === 'string'
      ? [manifestValue]
      : Array.isArray(manifestValue)
        ? manifestValue.filter((entry): entry is string => {
            return typeof entry === 'string';
          })
        : [];

  for (const relativePath of relativePaths) {
    const sourcePath = path.resolve(sourcePluginPath, relativePath);
    if (!isPathInside(sourcePluginPath, sourcePath)) {
      continue;
    }

    const projectedPath = path.resolve(projectedPluginPath, relativePath);
    if (isPathInside(projectedPluginPath, projectedPath)) {
      removePath(projectedPath);
    }
  }

  const defaultMcpPath = path.join(projectedPluginPath, '.mcp.json');
  if (isPathInside(projectedPluginPath, defaultMcpPath)) {
    removePath(defaultMcpPath);
  }
}

function writeProjectedManifest(
  projectedPluginPath: string,
  rawManifest: Record<string, unknown>,
): void {
  const withoutMcpServers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawManifest)) {
    if (key !== 'mcpServers') {
      withoutMcpServers[key] = value;
    }
  }
  const manifestDir = path.join(projectedPluginPath, '.claude-plugin');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'plugin.json'),
    JSON.stringify(withoutMcpServers, null, 2),
    'utf8',
  );
}

export function projectClaudePluginWithoutMcpServers(options: {
  sourcePluginPath: string;
  marketplaceId: string;
  pluginName: string;
  projectionRootDir: string;
  warnings: string[];
}): string {
  const projectedPluginPath = path.join(
    options.projectionRootDir,
    safeSegment(options.marketplaceId),
    safeSegment(options.pluginName),
  );
  if (!isPathInside(options.projectionRootDir, projectedPluginPath)) {
    options.warnings.push(
      `Projected path escaped "${options.projectionRootDir}"; using original plugin path.`,
    );
    return options.sourcePluginPath;
  }
  const manifestPath = path.join(
    options.sourcePluginPath,
    '.claude-plugin',
    'plugin.json',
  );
  const rawManifest = safeReadJson<Record<string, unknown>>(manifestPath);
  if (!rawManifest || !isRecord(rawManifest)) {
    options.warnings.push(
      `Plugin "${options.marketplaceId}/${options.pluginName}" has no readable Claude manifest; using original plugin path.`,
    );
    return options.sourcePluginPath;
  }

  removePath(projectedPluginPath);
  fs.mkdirSync(path.dirname(projectedPluginPath), { recursive: true });
  fs.cpSync(options.sourcePluginPath, projectedPluginPath, {
    recursive: true,
    force: true,
    dereference: false,
  });

  removeReferencedMcpFiles(
    options.sourcePluginPath,
    projectedPluginPath,
    rawManifest,
  );
  writeProjectedManifest(projectedPluginPath, rawManifest);
  return projectedPluginPath;
}
