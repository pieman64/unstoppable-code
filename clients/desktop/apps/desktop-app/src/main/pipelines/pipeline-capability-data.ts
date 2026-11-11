import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  getBundledPipelinesDir,
  getUserPipelineIndexPath,
  getUserPipelinesDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import type {
  IPCResult,
  Pipeline,
  PipelineData,
  PipelineIndexEntry,
  PipelineInfo,
} from '@canopy/execution-engine/types/pipeline';
import { parseShareRemoteMetadata } from '@canopy/protocol/sharing';

interface ParsedPipelineCacheEntry {
  mtimeMs: number;
  size: number;
  content: Pipeline;
}

const parsedPipelineCache = new Map<string, ParsedPipelineCacheEntry>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIndexEntry(value: unknown): PipelineIndexEntry | null {
  if (!isRecord(value)) return null;
  const { id, name, filename, createdAt, updatedAt } = value;
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof filename !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }
  const remote = parseShareRemoteMetadata(value.remote);
  return {
    id,
    name,
    filename,
    createdAt,
    updatedAt,
    description: typeof value.description === 'string' ? value.description : '',
    icon: typeof value.icon === 'string' ? value.icon : '',
    ...(remote ? { remote } : {}),
  };
}

function resolveIndexedFile(rootDir: string, filename: string): string | null {
  const root = path.resolve(rootDir);
  const filePath = path.resolve(root, filename);
  const relative = path.relative(root, filePath);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return filePath;
}

async function readIndex(indexPath: string): Promise<PipelineIndexEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
    if (!isRecord(parsed) || !Array.isArray(parsed.pipelines)) return [];
    return parsed.pipelines
      .map(parseIndexEntry)
      .filter((entry): entry is PipelineIndexEntry => entry !== null);
  } catch {
    return [];
  }
}

async function loadPipelineContent(filePath: string): Promise<Pipeline | null> {
  try {
    const fileStats = await stat(filePath);
    const cached = parsedPipelineCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === fileStats.mtimeMs &&
      cached.size === fileStats.size
    ) {
      return cached.content;
    }
    const raw = await readFile(filePath, 'utf8');
    // Keep a large catalog cooperative on first load; subsequent calls use the
    // mtime/size cache and avoid both I/O and YAML parsing.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const content = parsePipelineText(raw);
    parsedPipelineCache.set(filePath, {
      mtimeMs: fileStats.mtimeMs,
      size: fileStats.size,
      content,
    });
    return content;
  } catch {
    parsedPipelineCache.delete(filePath);
    return null;
  }
}

async function loadSource(
  source: 'bundled' | 'user',
  rootDir: string,
  indexPath: string,
): Promise<PipelineData[]> {
  const entries = await readIndex(indexPath);
  const loaded = await Promise.all(
    entries.map(async (entry): Promise<PipelineData | null> => {
      const filePath = resolveIndexedFile(rootDir, entry.filename);
      if (!filePath) return null;
      const content = await loadPipelineContent(filePath);
      if (!content) return null;
      const info: PipelineInfo = {
        ...entry,
        source,
        readonly: source === 'bundled',
      };
      return { info, content };
    }),
  );
  return loaded.filter((entry): entry is PipelineData => entry !== null);
}

/**
 * Read the stored pipeline definitions used by capability summaries without
 * synchronous main-thread filesystem calls. Parsed definitions are cached by
 * mtime and size so repeated detail-page navigation only stats the files.
 */
export async function listPipelineCapabilityData(): Promise<
  IPCResult<PipelineData[]>
> {
  try {
    const bundledRoot = getBundledPipelinesDir();
    const userRoot = getUserPipelinesDir();
    const [bundled, user] = await Promise.all([
      loadSource('bundled', bundledRoot, path.join(bundledRoot, 'index.json')),
      loadSource('user', userRoot, getUserPipelineIndexPath()),
    ]);
    return { success: true, data: [...bundled, ...user] };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
