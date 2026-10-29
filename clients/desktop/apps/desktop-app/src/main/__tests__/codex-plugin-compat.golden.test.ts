jest.mock('../lib/paths', () => ({
  getCodexCompatibilityCacheRootDir: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCodexQualifiedReferenceMap,
  ensureCodexCompatibleClaudePlugin,
  readClaudePluginCompatibilitySource,
} from '../plugins/codex-plugin-compat';
import { getCodexCompatibilityCacheRootDir } from '../lib/paths';

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'codex-plugin-compat');
const FIXED_MTIME = new Date('2026-08-26T12:00:00.000Z');
const getCodexCompatibilityCacheRootDirMock = jest.mocked(
  getCodexCompatibilityCacheRootDir,
);

interface GoldenFile {
  path: string;
  content: string;
}

interface GoldenProjection {
  pluginName: string;
  category: string;
  warnings: string[];
  files: GoldenFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGoldenFile(value: unknown): value is GoldenFile {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.content === 'string'
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
  );
}

function isGoldenFileArray(value: unknown): value is GoldenFile[] {
  return (
    Array.isArray(value) && value.every((entry: unknown) => isGoldenFile(entry))
  );
}

function isGoldenProjection(value: unknown): value is GoldenProjection {
  return (
    isRecord(value) &&
    typeof value.pluginName === 'string' &&
    typeof value.category === 'string' &&
    isStringArray(value.warnings) &&
    isGoldenFileArray(value.files)
  );
}

function setTreeMtime(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      setTreeMtime(entryPath);
    }
    fs.utimesSync(entryPath, FIXED_MTIME, FIXED_MTIME);
  }
  fs.utimesSync(root, FIXED_MTIME, FIXED_MTIME);
}

function collectGoldenFiles(
  root: string,
  cacheRoot: string,
  current: string = root,
): GoldenFile[] {
  const files: GoldenFile[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectGoldenFiles(root, cacheRoot, entryPath));
      continue;
    }
    files.push({
      path: path.relative(root, entryPath).split(path.sep).join('/'),
      content: fs
        .readFileSync(entryPath, 'utf8')
        .split(cacheRoot)
        .join('<CACHE_ROOT>'),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function readGoldenProjection(filePath: string): GoldenProjection {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isGoldenProjection(value)) {
    throw new Error(`Invalid golden projection: ${filePath}`);
  }
  return value;
}

describe('codex-plugin-compat golden projections', () => {
  let tempDir = '';
  let cacheRoot = '';

  beforeEach((): void => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-compat-golden-'));
    cacheRoot = path.join(tempDir, 'cache');
    getCodexCompatibilityCacheRootDirMock.mockReturnValue(cacheRoot);
  });

  afterEach((): void => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['comprehensive', 'default-mcp', 'no-conversion'])(
    'preserves the %s projection byte for byte',
    (fixtureName): void => {
      const pluginPath = path.join(tempDir, fixtureName);
      fs.cpSync(path.join(FIXTURE_ROOT, fixtureName), pluginPath, {
        recursive: true,
      });
      setTreeMtime(pluginPath);
      const source = readClaudePluginCompatibilitySource({
        pluginName:
          fixtureName === 'comprehensive'
            ? 'golden-plugin'
            : fixtureName === 'default-mcp'
              ? 'default-mcp-plugin'
              : 'metadata-only-plugin',
        pluginPath,
        marketplaceId: 'golden-market',
        category: 'development tools',
      });
      const result = ensureCodexCompatibleClaudePlugin(
        source,
        buildCodexQualifiedReferenceMap([source]),
      );
      const actual: GoldenProjection = {
        pluginName: result.pluginName,
        category: result.category,
        warnings: result.warnings,
        files: collectGoldenFiles(path.dirname(result.cacheDir), cacheRoot),
      };
      const expected = readGoldenProjection(
        path.join(FIXTURE_ROOT, 'golden', `${fixtureName}.json`),
      );
      expect(actual).toEqual(expected);
    },
  );

  it('flattens command names to capability-bundle-safe skill names', (): void => {
    const pluginPath = path.join(tempDir, 'comprehensive');
    fs.cpSync(path.join(FIXTURE_ROOT, 'comprehensive'), pluginPath, {
      recursive: true,
    });
    const source = readClaudePluginCompatibilitySource({
      pluginName: 'golden-plugin',
      pluginPath,
      marketplaceId: 'golden-market',
      category: 'development tools',
    });
    const referenceMap = buildCodexQualifiedReferenceMap([source]);
    expect(referenceMap.get('golden-plugin:review/deep:thing')).toBe(
      '$golden-plugin:review-deep-thing',
    );
  });
});
