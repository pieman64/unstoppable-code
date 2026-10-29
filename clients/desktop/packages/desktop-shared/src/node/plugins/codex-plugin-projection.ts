import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectCodexPluginWithoutMcpServers as projectInMemoryCodexPluginWithoutMcpServers } from '@canopy/plugin-interop';
import { isPathInside } from '../lib/path-safety';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function safeSegment(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return result && result !== '.' && result !== '..' ? result : 'plugin';
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function hasSymlinkedPathComponent(root: string, target: string): boolean {
  try {
    if (fs.lstatSync(root).isSymbolicLink()) return true;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
  }
  return false;
}

function rejectSymlinkedPath(
  root: string,
  target: string,
  description: string,
): void {
  if (hasSymlinkedPathComponent(root, target)) {
    throw new Error(`Refusing Codex plugin projection through ${description}`);
  }
}

function removePathAndVerify(target: string, description: string): void {
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.lstatSync(target);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  throw new Error(
    `Codex plugin projection could not verify removal of ${description}`,
  );
}

/**
 * Build a native Codex plugin projection with its MCP declarations removed.
 * Filesystem traversal and symlink rejection remain in this Node adapter; the
 * manifest/file-map projection is shared with browser-safe consumers.
 */
export function projectCodexPluginWithoutMcpServers(options: {
  sourcePluginPath: string;
  marketplaceId: string;
  pluginName: string;
  projectionRootDir: string;
  warnings: string[];
}): string {
  const destination = path.join(
    options.projectionRootDir,
    safeSegment(options.marketplaceId),
    safeSegment(options.pluginName),
  );
  const manifestPath = path.join(
    options.sourcePluginPath,
    '.codex-plugin',
    'plugin.json',
  );
  rejectSymlinkedPath(
    options.sourcePluginPath,
    manifestPath,
    'a symlinked source or manifest path',
  );
  const manifest = readJson(manifestPath);
  if (!manifest) {
    options.warnings.push(
      `Codex plugin "${options.marketplaceId}/${options.pluginName}" has no readable manifest; it was skipped to avoid exposing MCP credentials.`,
    );
    return '';
  }
  const configured = manifest.mcpServers;
  const references =
    typeof configured === 'string'
      ? [configured]
      : Array.isArray(configured)
        ? configured.filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
  rejectSymlinkedPath(
    options.projectionRootDir,
    destination,
    'a symlinked destination path',
  );
  removePathAndVerify(destination, 'the existing destination');
  for (const reference of references) {
    const sourceTarget = path.resolve(options.sourcePluginPath, reference);
    if (isPathInside(options.sourcePluginPath, sourceTarget)) {
      rejectSymlinkedPath(
        options.sourcePluginPath,
        sourceTarget,
        'a symlinked MCP reference path',
      );
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.cpSync(options.sourcePluginPath, destination, {
      recursive: true,
      force: true,
      dereference: false,
    });
    for (const reference of references) {
      const target = path.resolve(destination, reference);
      if (isPathInside(destination, target)) {
        rejectSymlinkedPath(
          destination,
          target,
          'a symlinked MCP reference path',
        );
        removePathAndVerify(target, 'an MCP reference');
      }
    }
    removePathAndVerify(
      path.join(destination, '.mcp.json'),
      'the default MCP config',
    );
    const projected = projectInMemoryCodexPluginWithoutMcpServers({
      files: new Map([
        ['.codex-plugin/plugin.json', fs.readFileSync(manifestPath, 'utf8')],
      ]),
      manifest,
    });
    const projectedManifest = projected.get('.codex-plugin/plugin.json');
    if (typeof projectedManifest !== 'string') {
      throw new Error('Codex plugin projection did not produce a manifest.');
    }
    const projectedManifestPath = path.join(
      destination,
      '.codex-plugin',
      'plugin.json',
    );
    rejectSymlinkedPath(
      destination,
      projectedManifestPath,
      'a symlinked projected manifest path',
    );
    fs.writeFileSync(projectedManifestPath, projectedManifest, 'utf8');
    return destination;
  } catch (error) {
    try {
      removePathAndVerify(destination, 'the failed projection');
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
      const failure = new Error(
        `Codex plugin projection failed and its destination could not be removed: ${cleanupMessage}`,
      );
      Object.defineProperty(failure, 'cause', {
        value: error,
        configurable: true,
      });
      throw failure;
    }
    throw error;
  }
}
