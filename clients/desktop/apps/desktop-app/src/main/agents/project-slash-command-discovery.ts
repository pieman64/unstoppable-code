import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import type { SlashCommandData } from '@canopy/desktop-shared/types';

const MAX_METADATA_FILES = 1_000;
const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_COMMAND_FILE_BYTES = 1024 * 1024;
const MAX_METADATA_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_CONTENT_DESCRIPTION_LENGTH = 100;
const MAX_ARGUMENT_HINT_LENGTH = 500;

interface ScanBudget {
  files: number;
  bytes: number;
}

interface CommandFrontmatter {
  description?: string;
  'argument-hint'?: string;
  'user-invocable'?: boolean;
}

function isMissingFilesystemEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

const FRONTMATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;
const FRONTMATTER_FIELD_RE = /^[A-Za-z0-9_-]+\s*:/;
const COMMAND_FRONTMATTER_FIELD_RE =
  /^(description|argument-hint|user-invocable)\s*:\s*(.*)$/;

async function readMetadataFile(
  filePath: string,
  budget: ScanBudget,
  maxBytes: number,
  signal?: AbortSignal,
  failClosed = false,
): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    if (stats.size > maxBytes) return null;
    if (stats.size > budget.bytes) return null;
    budget.bytes -= stats.size;
    return await readFile(filePath, { encoding: 'utf8', signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (failClosed && !isMissingFilesystemEntry(error)) throw error;
    return null;
  }
}

async function isRealDirectory(
  directoryPath: string,
  signal?: AbortSignal,
  failClosed = false,
): Promise<boolean> {
  try {
    signal?.throwIfAborted();
    const stats = await lstat(directoryPath);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    signal?.throwIfAborted();
    if (failClosed && !isMissingFilesystemEntry(error)) throw error;
    return false;
  }
}

async function readDirectory(
  directoryPath: string,
  maxEntries: number,
  signal?: AbortSignal,
  failClosed = false,
): Promise<Dirent[] | null> {
  try {
    signal?.throwIfAborted();
    if (!(await isRealDirectory(directoryPath, signal, failClosed)))
      return null;
    const entries: Dirent[] = [];
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      entries.push(entry);
      if (entries.length >= maxEntries) break;
    }
    return entries;
  } catch (error) {
    signal?.throwIfAborted();
    if (failClosed && !isMissingFilesystemEntry(error)) throw error;
    return null;
  }
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function parseQuotedScalar(value: string): string | undefined {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return undefined;
}

function parseBooleanScalar(value: string): boolean | undefined {
  if (value.startsWith('"') || value.startsWith("'")) return undefined;
  const normalized = value
    .replace(/\s+#.*$/, '')
    .trim()
    .toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function parseCommandFrontmatter(content: string): CommandFrontmatter | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const frontmatter: CommandFrontmatter = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const fieldMatch = line.match(COMMAND_FRONTMATTER_FIELD_RE);
    if (!fieldMatch) continue;

    const field = fieldMatch[1];
    const rawValue = fieldMatch[2].trim();
    if (!rawValue || /^[&*[{|>!]/.test(rawValue)) continue;

    switch (field) {
      case 'user-invocable': {
        const value = parseBooleanScalar(rawValue);
        if (value !== undefined) frontmatter['user-invocable'] = value;
        break;
      }
      case 'description':
      case 'argument-hint': {
        const quotedValue = parseQuotedScalar(rawValue);
        if (quotedValue !== undefined) {
          frontmatter[field] = quotedValue;
        } else if (!rawValue.startsWith('"') && !rawValue.startsWith("'")) {
          frontmatter[field] = rawValue.replace(/\s+#.*$/, '').trim();
        }
        break;
      }
    }
  }
  return frontmatter;
}

function commandFromMarkdown(
  content: string,
  fallbackName: string,
): SlashCommandData | null {
  // This path runs automatically against repository-controlled files. Parse
  // only the scalar fields we consume so YAML aliases, merge keys, and nested
  // collections can never expand into an unbounded synchronous object graph.
  const frontmatter = parseCommandFrontmatter(content);
  if (frontmatter?.['user-invocable'] === false) return null;

  // Claude resolves both project skills and legacy commands by their path.
  // A skill frontmatter `name` is presentation metadata, but this transport
  // has only the invocation name, so retain the canonical directory key.
  const name = fallbackName;
  if (!name || name.length > MAX_NAME_LENGTH) return null;

  return {
    name,
    description:
      boundedString(frontmatter?.description, MAX_DESCRIPTION_LENGTH) ||
      descriptionFromContent(content),
    argumentHint: boundedString(
      frontmatter?.['argument-hint'],
      MAX_ARGUMENT_HINT_LENGTH,
    ),
  };
}

function descriptionFromContent(content: string): string {
  // Claude derives a short label from the first prompt line when description
  // metadata is absent. Read the text only, without evaluating prompt content.
  const body = content.replace(FRONTMATTER_RE, '').trimStart();
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() === '---') {
    let metadataBoundary = 0;
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) break;
      if (line === '---') {
        metadataBoundary = index;
        break;
      }
      if (FRONTMATTER_FIELD_RE.test(line)) metadataBoundary = index;
    }
    lines.shift();
    while (lines.length > 0) {
      const line = lines[0].trim();
      if (!line || line === '---') {
        lines.shift();
        break;
      }
      if (
        !FRONTMATTER_FIELD_RE.test(line) &&
        !(line.startsWith('#') && metadataBoundary > 1)
      ) {
        break;
      }
      lines.shift();
      metadataBoundary -= 1;
    }
  }
  const firstLine =
    lines
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line && line !== '---') ?? '';
  return firstLine.length > MAX_CONTENT_DESCRIPTION_LENGTH
    ? `${firstLine.slice(0, MAX_CONTENT_DESCRIPTION_LENGTH - 3)}...`
    : firstLine;
}

async function discoverProjectSkills(
  claudeDir: string,
  budget: ScanBudget,
  signal?: AbortSignal,
): Promise<SlashCommandData[]> {
  const skillsRoot = path.join(claudeDir, 'skills');
  const entries = await readDirectory(skillsRoot, budget.files, signal);
  if (!entries) return [];

  const commands: SlashCommandData[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (budget.files <= 0) break;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    budget.files -= 1;
    const content = await readMetadataFile(
      path.join(skillsRoot, entry.name, 'SKILL.md'),
      budget,
      MAX_SKILL_FILE_BYTES,
      signal,
    );
    if (!content) continue;
    const command = commandFromMarkdown(content, entry.name);
    if (command) commands.push(command);
  }
  return commands;
}

async function discoverProjectCommands(
  claudeDir: string,
  budget: ScanBudget,
  signal?: AbortSignal,
): Promise<SlashCommandData[]> {
  const commandsRoot = path.join(claudeDir, 'commands');
  const pending = [{ absolute: commandsRoot, relative: '' }];
  const commands: SlashCommandData[] = [];

  while (pending.length > 0 && budget.files > 0) {
    signal?.throwIfAborted();
    const current = pending.pop();
    if (!current) break;
    const entries = await readDirectory(current.absolute, budget.files, signal);
    if (!entries) continue;

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (budget.files <= 0) break;
      if (entry.isSymbolicLink()) continue;
      budget.files -= 1;
      const relative = current.relative
        ? path.join(current.relative, entry.name)
        : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.md') continue;

      const content = await readMetadataFile(
        absolute,
        budget,
        MAX_COMMAND_FILE_BYTES,
        signal,
      );
      if (!content) continue;
      const fallbackName = relative
        .slice(0, -path.extname(relative).length)
        .split(path.sep)
        .join(':');
      const command = commandFromMarkdown(content, fallbackName);
      if (command) commands.push(command);
    }
  }

  return commands;
}

/**
 * Read only repository slash-command metadata and invocable source locations.
 * Repository settings, hooks, plugins, helpers, and environment values are
 * deliberately never parsed.
 */
export async function discoverProjectSlashCommands(
  cwd: string,
  signal?: AbortSignal,
): Promise<SlashCommandData[]> {
  signal?.throwIfAborted();
  const budget: ScanBudget = {
    files: MAX_METADATA_FILES,
    bytes: MAX_METADATA_TOTAL_BYTES,
  };
  const claudeDir = path.join(cwd, '.claude');
  if (!(await isRealDirectory(claudeDir, signal))) return [];

  const skills = await discoverProjectSkills(claudeDir, budget, signal);
  const commands = await discoverProjectCommands(claudeDir, budget, signal);

  const byName = new Map<string, SlashCommandData>();
  for (const command of [...commands, ...skills]) {
    byName.set(command.name, command);
  }
  return Array.from(byName.values());
}

export async function discoverProjectInvocableSources(
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  entries: Array<{
    name: string;
    kind: 'command' | 'skill';
    absolutePath: string;
  }>;
  scannedDirectories: string[];
}> {
  signal?.throwIfAborted();
  const budget: ScanBudget = {
    files: MAX_METADATA_FILES,
    bytes: MAX_METADATA_TOTAL_BYTES,
  };
  const claudeDir = path.join(cwd, '.claude');
  if (!(await isRealDirectory(claudeDir, signal, true))) {
    return { entries: [], scannedDirectories: [claudeDir] };
  }

  const scannedDirectories = new Set<string>([claudeDir]);
  const entries: Array<{
    name: string;
    kind: 'command' | 'skill';
    absolutePath: string;
  }> = [];

  const skillsRoot = path.join(claudeDir, 'skills');
  if (await isRealDirectory(skillsRoot, signal, true)) {
    scannedDirectories.add(skillsRoot);
    const skills = await readDirectory(skillsRoot, budget.files, signal, true);
    for (const entry of (skills ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      signal?.throwIfAborted();
      if (budget.files <= 0) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      budget.files -= 1;
      const absolutePath = path.join(skillsRoot, entry.name);
      const content = await readMetadataFile(
        path.join(absolutePath, 'SKILL.md'),
        budget,
        MAX_SKILL_FILE_BYTES,
        signal,
        true,
      );
      if (!content || !commandFromMarkdown(content, entry.name)) continue;
      entries.push({ name: entry.name, kind: 'skill', absolutePath });
    }
  }

  const commandsRoot = path.join(claudeDir, 'commands');
  const pending = [{ absolute: commandsRoot, relative: '' }];
  while (pending.length > 0 && budget.files > 0) {
    signal?.throwIfAborted();
    const current = pending.pop();
    if (!current || !(await isRealDirectory(current.absolute, signal, true)))
      continue;
    scannedDirectories.add(current.absolute);
    const children = await readDirectory(
      current.absolute,
      budget.files,
      signal,
      true,
    );
    for (const child of (children ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      signal?.throwIfAborted();
      if (budget.files <= 0) break;
      if (child.isSymbolicLink()) continue;
      budget.files -= 1;
      const relative = current.relative
        ? path.join(current.relative, child.name)
        : child.name;
      const absolute = path.join(current.absolute, child.name);
      if (child.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!child.isFile() || path.extname(child.name) !== '.md') continue;
      const content = await readMetadataFile(
        absolute,
        budget,
        MAX_COMMAND_FILE_BYTES,
        signal,
        true,
      );
      if (!content) continue;
      const name = relative
        .slice(0, -path.extname(relative).length)
        .split(path.sep)
        .join(':');
      if (!commandFromMarkdown(content, name)) continue;
      entries.push({ name, kind: 'command', absolutePath: absolute });
    }
  }

  const byName = new Map<string, (typeof entries)[number]>();
  for (const entry of entries) {
    const existing = byName.get(entry.name);
    if (!existing || entry.kind === 'skill') {
      byName.set(entry.name, entry);
    }
  }
  return {
    entries: Array.from(byName.values()),
    scannedDirectories: Array.from(scannedDirectories),
  };
}
