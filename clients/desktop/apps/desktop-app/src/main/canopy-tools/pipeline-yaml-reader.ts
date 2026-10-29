import {
  authorizeProjectPipelineRequest,
  assertStoredPipelineContext,
} from '../pipelines/pipeline-install-context';
import { pipelineResourceContextEnabled } from '../pipelines/resource-lanes';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import * as pipelineStore from '../pipelines/pipeline-service';
import { discoverProjectPipelines } from '../pipelines/project-pipeline-discovery';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';

export interface PipelineYamlLineRange {
  startLine: number;
  endLine?: number;
}

export interface PipelineYamlReadRequest {
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  repoId?: string;
  startLine?: number;
  endLine?: number;
  ranges?: PipelineYamlLineRange[];
  pattern?: string;
  fixedString?: boolean;
  ignoreCase?: boolean;
  invertMatch?: boolean;
  context?: number;
  beforeContext?: number;
  afterContext?: number;
  maxMatches?: number;
}

export interface PipelineYamlReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface LoadedPipelineYaml {
  info: Pick<PipelineInfo, 'id' | 'name' | 'source' | 'filename'>;
  filePath: string;
  raw: string;
}

interface NumberedLine {
  lineNumber: number;
  text: string;
}

const MAX_REGEX_PATTERN_LENGTH = 1000;

function splitLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function selectRange(
  totalLines: number,
  range: PipelineYamlLineRange,
): number[] {
  const start = range.startLine;
  const end = range.endLine ?? totalLines;
  if (start > end) {
    throw new Error('startLine must be less than or equal to endLine.');
  }
  const clampedStart = Math.max(1, start);
  const clampedEnd = Math.min(totalLines, end);
  const selected: number[] = [];
  for (let line = clampedStart; line <= clampedEnd; line += 1) {
    selected.push(line);
  }
  return selected;
}

function selectLineNumbers(
  request: PipelineYamlReadRequest,
  totalLines: number,
): number[] {
  const requestedRanges =
    request.ranges && request.ranges.length > 0
      ? request.ranges
      : [
          {
            startLine: request.startLine ?? 1,
            endLine: request.endLine ?? totalLines,
          },
        ];
  const selected = new Set<number>();
  for (const range of requestedRanges) {
    for (const lineNumber of selectRange(totalLines, range)) {
      selected.add(lineNumber);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function createMatcher(
  request: PipelineYamlReadRequest,
): ((line: string) => boolean) | null {
  const pattern = request.pattern;
  if (!pattern) return null;
  if (request.fixedString) {
    const needle = request.ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => {
      const haystack = request.ignoreCase ? line.toLowerCase() : line;
      return haystack.includes(needle);
    };
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern must be at most ${MAX_REGEX_PATTERN_LENGTH} characters.`,
    );
  }
  const regex = new RegExp(pattern, request.ignoreCase ? 'i' : undefined);
  return (line: string) => regex.test(line);
}

function filterLines(
  entries: NumberedLine[],
  request: PipelineYamlReadRequest,
): {
  lines: NumberedLine[];
  matchedLineCount: number;
  truncatedMatches: boolean;
} {
  const matcher = createMatcher(request);
  if (!matcher) {
    return {
      lines: entries,
      matchedLineCount: entries.length,
      truncatedMatches: false,
    };
  }

  const before = request.context ?? request.beforeContext ?? 0;
  const after = request.context ?? request.afterContext ?? 0;
  const maxMatches = request.maxMatches;
  const matchedIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const matched = matcher(entry.text);
    if (request.invertMatch ? !matched : matched) {
      if (maxMatches !== undefined && matchedIndexes.length >= maxMatches) {
        return {
          lines: expandContext(entries, matchedIndexes, before, after),
          matchedLineCount: matchedIndexes.length,
          truncatedMatches: true,
        };
      }
      matchedIndexes.push(index);
    }
  }
  return {
    lines: expandContext(entries, matchedIndexes, before, after),
    matchedLineCount: matchedIndexes.length,
    truncatedMatches: false,
  };
}

function expandContext(
  entries: NumberedLine[],
  matchedIndexes: number[],
  before: number,
  after: number,
): NumberedLine[] {
  const selected = new Set<number>();
  for (const index of matchedIndexes) {
    const start = Math.max(0, index - before);
    const end = Math.min(entries.length - 1, index + after);
    for (let selectedIndex = start; selectedIndex <= end; selectedIndex += 1) {
      selected.add(selectedIndex);
    }
  }
  return Array.from(selected)
    .sort((left, right) => left - right)
    .map((index) => entries[index])
    .filter((entry): entry is NumberedLine => entry !== undefined);
}

function formatLine(entry: NumberedLine, width: number): string {
  return `${String(entry.lineNumber).padStart(width, ' ')}: ${entry.text}`;
}

function loadStoredPipelineYaml(pipelineId: string): LoadedPipelineYaml | null {
  const text = pipelineStore.getPipelineText(pipelineId);
  const pathResult = pipelineStore.getPipelinePath(pipelineId);
  if (!text.success || !text.data || !pathResult.success || !pathResult.data) {
    return null;
  }
  const infos = pipelineStore.listPipelines();
  const info = infos.success
    ? infos.data?.find((entry) => entry.id === pipelineId)
    : undefined;
  return {
    info: {
      id: pipelineId,
      name: info?.name ?? pipelineId,
      source: info?.source ?? 'user',
      filename: info?.filename ?? path.basename(pathResult.data),
    },
    filePath: pathResult.data,
    raw: text.data,
  };
}

async function loadProjectPipelineYaml(
  pipelineId: string,
  cwd: string,
  projectId: string,
): Promise<LoadedPipelineYaml | null> {
  const pipelines = await discoverProjectPipelines(cwd).catch(() => []);
  const info = pipelines.find((entry) => entry.id === pipelineId);
  if (!info?.filePath) return null;
  if (pipelineResourceContextEnabled()) {
    const resolved = await authorizeProjectPipelineRequest({
      id: pipelineId,
      cwd,
      filePath: info.filePath,
    });
    if (resolved.projectId !== projectId)
      throw new Error('Pipeline unavailable (context-mismatch)');
  }
  return {
    info,
    filePath: info.filePath,
    raw: await readFile(info.filePath, 'utf8'),
  };
}

async function loadPipelineYaml(
  request: PipelineYamlReadRequest,
): Promise<LoadedPipelineYaml | null> {
  if (request.pipelineId.startsWith('curated:')) {
    const { getManagedCuratedPipeline } =
      await import('../pipelines/curated-pipeline-catalog');
    const pipeline = await getManagedCuratedPipeline(request.pipelineId);
    const filePath = pipeline.info.filePath;
    if (!filePath)
      throw new Error('Curated pipeline did not provide a managed definition.');
    return {
      info: pipeline.info,
      filePath,
      raw: await readFile(filePath, 'utf8'),
    };
  }
  const cwd = request.repoId
    ? resolveWorktreeCwd(request.projectId, request.worktreeId, request.repoId)
    : resolveWorktreeCwd(request.projectId, request.worktreeId);
  if (pipelineResourceContextEnabled()) {
    if (request.pipelineId.startsWith('project--'))
      return loadProjectPipelineYaml(
        request.pipelineId,
        cwd,
        request.projectId,
      );
    await assertStoredPipelineContext(request.pipelineId, request.projectId);
  }
  return (
    loadStoredPipelineYaml(request.pipelineId) ??
    (await loadProjectPipelineYaml(request.pipelineId, cwd, request.projectId))
  );
}

export async function readWorktreePipelineYaml(
  request: PipelineYamlReadRequest,
): Promise<PipelineYamlReadResult> {
  let loaded: LoadedPipelineYaml | null;
  try {
    loaded = await loadPipelineYaml(request);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to load pipeline YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!loaded) {
    return {
      ok: false,
      error: `Pipeline ${request.pipelineId} was not found.`,
    };
  }

  const rawLines = splitLines(loaded.raw);
  let selectedLineNumbers: number[];
  try {
    selectedLineNumbers = selectLineNumbers(request, rawLines.length);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const rangedLines = selectedLineNumbers.map((lineNumber) => ({
    lineNumber,
    text: rawLines[lineNumber - 1] ?? '',
  }));

  let filtered: ReturnType<typeof filterLines>;
  try {
    filtered = filterLines(rangedLines, request);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const width = String(rawLines.length).length;
  const filterSummary = request.pattern
    ? [
        `Pattern: ${request.pattern}`,
        `Matched lines: ${String(filtered.matchedLineCount)}`,
        ...(filtered.truncatedMatches
          ? ['Matches truncated by maxMatches.']
          : []),
      ]
    : [];
  const body =
    filtered.lines.length > 0
      ? filtered.lines.map((entry) => formatLine(entry, width)).join('\n')
      : 'No lines matched.';

  return {
    ok: true,
    text: [
      `Pipeline YAML: ${loaded.info.name} (${loaded.info.id})`,
      `Source: ${loaded.info.source}`,
      `Filename: ${loaded.info.filename}`,
      `File: ${loaded.filePath}`,
      `Total lines: ${String(rawLines.length)}`,
      ...filterSummary,
      '---',
      body,
    ].join('\n'),
  };
}
